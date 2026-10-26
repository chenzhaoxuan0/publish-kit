// lib/preflight.cjs — 起浏览器**之前**的体检
//
// 为什么单独一层（这是本项目被实际问题逼出来的设计）：
//
//   任何「上传后确认成功」的自动化，判据都只能证明**页面上的东西**，
//   证明不了**喂进去的东西**。一个真实事故：
//     投递单里某平台的 images 只列了 1 张 → count=1 → 三个平台各只传了 1 张图，
//     而每个平台的判据都「通过」了（「渲染张数 ≥ count」，1 ≥ 1 恒成立）。
//     脚本报成功、语气笃定，而结果三个平台全是残缺图集。
//
//   → 修法：**起浏览器之前**先核对「要传几张」与「目录里真有几张」。
//     体检不过就不执行 —— 宁可不发，也不发错。
//
// 本模块的契约：
//   · 体检**不碰浏览器**（秒级），所以可以在起 Chrome 之前跑
//   · 任何一项 FAIL → 抛错，调用方**不要**继续填单
//   · WARN 不阻塞（是提醒，不是错误）
//
// 用法：
//   const { preflight } = require('../lib/preflight.cjs');
//   preflight({
//     platform: 'douyin',
//     mediaDir: './cards',           // 图集目录（要数文件）
//     declaredCount: 7,             // 声称要传几张
//     bodyText: '正文…',            // 正文（查长度区间 + 违禁）
//     title: '标题',                // 标题（查长度）
//     limits: { titleMax: 20, bodyMax: 900 },
//   });

const fs = require('fs');
const path = require('path');

/** 正则元字符转义（用于把平台字段当字面量匹配） */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 图集目录里可用的图片，按序号归一。
 *
 * ⚠️ 命名约定（publish-kit 各平台脚本实际在用）：
 *   `img-01.png`（主流约定：抖音/微博/知乎都按这个）· `01.png` · `card_34_01.png`
 *   → 序号取**文件名里的数字段**，`img-01.png` 的序号是 01 而不是「没有数字」。
 *   （第一版只匹配 `/^(\d+)/`，结果 `img-01.png` 一张都认不出来 →
 *     所有图文线的体检都会永远失败。自检 selftest.cjs 抓到的。）
 */
function listImages(dir) {
  if (!dir || !fs.existsSync(dir)) return { exists: false, files: [], byName: new Map() };
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort();
  const byName = new Map();
  for (const f of files) {
    // ① img-01.png / IMG_01.png —— publish-kit 主约定
    let m = f.match(/^img[-_](\d+)/i);
    // ② 01.png —— 纯数字开头
    if (!m) m = f.match(/^(\d+)/);
    // ③ card_34_01.png 之类 —— 取最后一个数字段
    if (!m) {
      const all = [...f.matchAll(/(\d+)/g)];
      if (all.length) m = { 1: all[all.length - 1][1] };
    }
    if (!m) continue;
    const key = String(Number(m[1])).padStart(2, '0');
    // 同序号取**排序靠后**的（card_34_end 之类通常在最后，但同名覆盖取后者更安全）
    if (!byName.has(key) || f > byName.get(key).name) {
      byName.set(key, { name: f, path: path.join(dir, f) });
    }
  }
  return { exists: true, files, byName, dir };
}

/**
 * 图集**序号连续性**检查：归一后的序号有没有「洞」。
 *
 * 为什么单列一道（张数对得上也查不出来的那类）：
 *   listImages() 把文件名里的数字段归一成 01/02/03…，但**归一之后序号可能不连续** ——
 *   目录里是 01,02,03,05，说明第 04 张没生成（或命名跳号了）。
 *   这种「在但序错」传上去，图集顺序就是错的，而「缺第 N 张」那道判据看不到它。
 *
 * 范围怎么定（⚠️ 这里刻意保守，避免误伤）：
 *   只看 [1 .. R]，R = 声称张数，再沿**紧邻的连续段**往后延（declaredCount+1 在，就接着延）。
 *   → 目录里多出来的封面等**离群文件**（如 cover_3411.png → 序号 3411）不会被当成洞，
 *     不会因为一个封面文件把整条发布线拦下来。
 *
 * @param {Map<string,object>} byName  listImages() 的 byName
 * @param {number} declaredCount 声称要传几张
 * @returns {{holes:string[], seqs:number[]}} holes = 断掉的序号（'04' 这种两位数写法）
 */
function continuityHoles(byName, declaredCount) {
  const seqs = [...byName.keys()]
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!seqs.length) return { holes: [], seqs };
  const set = new Set(seqs);
  let R = declaredCount;
  while (set.has(R + 1)) R++;
  const holes = [];
  for (let i = 1; i <= R; i++) {
    if (!set.has(i)) holes.push(String(i).padStart(2, '0'));
  }
  return { holes, seqs };
}

const FAIL = [];
const WARN = [];

/**
 * 跑一遍体检。返回结果；**有 FAIL 时抛错**（调用方应直接中止填单）。
 *
 * @param {Object} o
 * @param {string} o.platform 平台 key
 * @param {string} [o.mediaDir] 图集目录
 * @param {number} [o.declaredCount] 声称要传几张
 * @param {string} [o.bodyText] 正文
 * @param {string} [o.title] 标题
 * @param {Object} [o.limits] {titleMax, titleMin, bodyMax, bodySoftMax, bodyMin}
 *   bodyMax = **有实测依据**的平台硬上限（超了阻塞）
 *   bodySoftMax = **没有实测依据**的口径（超了只 WARN，不阻塞）
 * @param {string[]} [o.forbid] 正文里不该出现的模式（正则字符串）
 * @param {boolean} [o.strict] true 时 WARN 也抛错（默认 false）
 */
function preflight(o = {}) {
  FAIL.length = 0;
  WARN.length = 0;
  const platform = o.platform || 'unknown';
  const lim = o.limits || {};

  // ── ① 图集：张数 vs 实际 + 序号连续性 ─────────────────────────────
  if (o.mediaDir || o.declaredCount) {
    const img = listImages(o.mediaDir);
    if (!img.exists && o.declaredCount) {
      FAIL.push(`图集目录不存在：${o.mediaDir}`);
    } else if (o.declaredCount) {
      const byName = img.byName;
      const missing = [];
      for (let i = 1; i <= o.declaredCount; i++) {
        const key = String(i).padStart(2, '0');
        if (!byName.has(key)) missing.push(key);
      }
      const seqText = [...byName.keys()].sort().join(', ') || '（无）';
      if (missing.length) {
        FAIL.push(
          `图集不足：声称要传 ${o.declaredCount} 张，但 ${o.mediaDir} 里缺 ${missing.join(', ')}` +
            `（实际可用 ${byName.size} 张）。\n` +
            `  ⚠ 这正是「三个平台各只传了 1 张、但每个平台判据都通过」那次事故的根因 —— 体检不过就别起浏览器。`
        );
      } else if (byName.size < o.declaredCount) {
        // ⚠️ 原来这里只是 WARN，现在改成 FAIL：
        //   声明要传 N 张而目录里不足 N 张 = **一定会传少**，
        //   和本文件「体检不过就不起浏览器」的契约是同一件事 —— 宁可不发，也不发错。
        FAIL.push(
          `图集目录里只有 ${byName.size} 张可用图（声称 ${o.declaredCount} 张，现有序号 ${seqText}）。\n` +
            `  ⚠ 声明要传 N 张而目录里不足 N 张 = 一定会传少 —— 与本文件同一条契约：宁可不发，也不发错。`
        );
      }
      // 连续性：归一后的序号有洞 → 顺序会错（「在但序错」，张数那道判据看不到的那类）
      const { holes } = continuityHoles(byName, o.declaredCount);
      if (holes.length) {
        FAIL.push(
          `图集序号断了：${o.mediaDir} 里缺序号 ${holes.join(', ')}（现有 ${seqText}）。\n` +
            `  ⚠ 序号有洞就等于顺序错位。请人工确认是「漏生成」还是「命名跳号」，补齐后再发。`
        );
      }
    }
  }

  // ── ② 正文长度 ───────────────────────────────────────────────────
  if (typeof o.bodyText === 'string') {
    const n = [...o.bodyText].length;
    if (lim.bodyMax && n > lim.bodyMax) {
      FAIL.push(`正文 ${n} 字 > 上限 ${lim.bodyMax}（平台会截断）`);
    }
    // 软线：**没有实测平台硬上限**的口径用这个 —— 超了只提醒，不拦。
    // （例：微博九宫格未见平台硬上限记录，仓库既有口径是 900 字**信噪比软线**，
    //   超了由平台自己拦；硬闸没有实测依据就不能设，否则口径一改就误拦。）
    if (lim.bodySoftMax && n > lim.bodySoftMax && !(lim.bodyMax && n > lim.bodyMax)) {
      WARN.push(`正文 ${n} 字 > 软线 ${lim.bodySoftMax}（非平台限制，自行判断是否再砍）`);
    }
    if (lim.bodyMin && n < lim.bodyMin) {
      WARN.push(`正文 ${n} 字 < 下限 ${lim.bodyMin}`);
    }
    // 未定义 / NaN 之类 —— 上游生成 bug 外溢到线上内容的经典形态
    if (/undefined|NaN|\[object Object\]/.test(o.bodyText)) {
      FAIL.push('正文含 undefined / NaN / [object Object] —— 上游生成 bug，先修文件再填单');
    }
  }

  // ── ③ 标题长度 ───────────────────────────────────────────────────
  if (typeof o.title === 'string' && o.title) {
    const n = [...o.title].length;
    if (lim.titleMax && n > lim.titleMax) {
      FAIL.push(`标题 ${n} 字 > 上限 ${lim.titleMax}：${o.title}`);
    }
    if (lim.titleMin && n < lim.titleMin) {
      WARN.push(`标题 ${n} 字 < 下限 ${lim.titleMin}（平台建议值）`);
    }
  }

  // ── ④ 违禁内容（联系方式 / 外链）──────────────────────────────────
  if (typeof o.bodyText === 'string' && Array.isArray(o.forbid)) {
    for (const pat of o.forbid) {
      const re = new RegExp(pat);
      if (re.test(o.bodyText)) {
        FAIL.push(`正文命中违禁模式 /${pat}/ —— 平台会判违规，先改文案`);
      }
    }
  }

  // ── 输出 ─────────────────────────────────────────────────────────
  for (const w of WARN) console.warn(`⚠ [preflight:${platform}] ${w}`);
  for (const f of FAIL) console.error(`✗ [preflight:${platform}] ${f}`);

  if (FAIL.length) {
    const err = new Error(
      `起浏览器前体检未通过（${platform}），已中止填单：\n` +
        FAIL.map((f) => `  ✗ ${f}`).join('\n') +
        `\n  体检不碰浏览器、秒级；不过就不执行 —— 宁可不发，也不发错。`
    );
    err.preflight = { platform, fail: [...FAIL], warn: [...WARN] };
    throw err;
  }
  if (WARN.length) {
    console.log(`[preflight:${platform}] ✓ 通过（${WARN.length} 条提醒）`);
  } else {
    console.log(`[preflight:${platform}] ✓ 通过`);
  }
  return { platform, fail: [], warn: [...WARN] };
}

module.exports = { preflight, listImages };
