// lib/wait.cjs — 等待层：条件等待 + 随机节奏
//
// 为什么单独一个文件：publish-kit 的 8 个平台脚本原本各自写 `sleep()` / `waitForTimeout()`，
// 等得长短全凭手感。这里把两种等待统一成两种语义明确的原语：
//
//   ① waitFor(fn) —— **条件等待**：轮询直到条件成立。
//      用于「等页面上某个东西出现」这类场景。
//      ⚠️ 固定 sleep 在这里是最常见的错误来源：等不够就往下走 → 后续动作落空；
//      等太久就是白等（实测知乎 Modal 的初等窗口从 60s 缩到 25s，省的是真金白银的墙钟）。
//
//   ② humanDelay() —— **随机节奏**：给人看的停顿用随机值。
//      平台风控看的是「数据形状」——每次都 sleep(1000) 每次都一样 = 机器特征。
//      真人打字有节奏波动，所以这里给区间而不是定值。
//      ⚠️ 但**别拿它当等待条件用**：它只是停顿，不是「等到某状态」。
//
// 这两条是本项目在真实平台上反复验证过的做法，改脚本时优先用它们，
// 而不是手写 waitForTimeout。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 条件等待：轮询 fn 直到返回 truthy。
 *
 * @param {Function} fn  返回 truthy 即视为就绪。**抛异常不算失败**，继续等。
 * @param {Object} opts
 * @param {number} opts.timeout  总超时（ms）
 * @param {number} opts.interval  轮询间隔（ms）
 * @param {string} opts.step  日志标签（超时信息里用）
 * @param {string} opts.hint  超时时的额外排查提示
 * @returns {Promise<any>} fn 的返回值
 * @throws {Error} 超时（信息里带上最后一次状态，便于判断是「没出现」还是「出现了但判定失败」）
 */
async function waitFor(fn, { timeout = 15000, interval = 400, step = 'wait', hint = '' } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
    await sleep(interval);
  }
  const detail =
    `条件等待超时（${timeout}ms）。最后一次状态：${JSON.stringify(last)}` +
    (lastErr ? `；最后一次异常：${lastErr}` : '') +
    (hint ? `\n  排查提示：${hint}` : '');
  throw new Error(`[${step}] ${detail}`);
}

/**
 * 条件等待的「不抛错」版本：超时返回 null。
 * 用于「有更好，没有也继续」的场景（比如补图、复核）。
 */
async function waitForOrNull(fn, opts = {}) {
  try {
    return await waitFor(fn, opts);
  } catch (_) {
    return null;
  }
}

/**
 * 随机节奏停顿（给人看的停顿，不是等待条件）。
 *
 * @param {number} min 最小 ms
 * @param {number} max 最大 ms
 * @param {string} step 日志标签
 */
async function humanDelay(min = 300, max = 1200, step = 'wait') {
  const ms = Math.floor(min + Math.random() * Math.max(1, max - min));
  console.log(`[${step}] 等待 ${ms}ms（随机区间 ${min}~${max}）`);
  await sleep(ms);
}

/**
 * 一次性灌入长文本（比逐字 type 快一个数量级）。
 *
 * 实测（抖音视频简介 958 字）：逐块 type 要 12s，insertText 约 0.6s，省约 11s。
 * 原理：逐字 type 每敲一个字符都是一次 CDP 往返，N 个字符 = N 次往返。
 *
 * ⚠️ **必须回读校验**：insertText 不保证触发编辑器的 input 事件，
 *    有些编辑器（React 受控）会「看起来插进去了但 state 没收到」。
 *    对不上就**自动退回**逐块输入，不把半截正文交割出去。
 *
 * @param {Object} page  Playwright page（需支持 keyboard.insertText）
 * @param {Function} readLength 回读正文字数的函数（返回数字）
 * @param {string} text 要插入的文本
 * @param {Object} opts
 * @returns {Promise<boolean>} true = insertText 成功且校验通过；false = 已退回逐块输入
 */
async function fillLongText(page, readLength, text, { step = 'fill', chunk = 30, delay = [40, 120] } = {}) {
  const want = [...text].length;
  try {
    await page.keyboard.insertText(text);
    await sleep(400);
    const got = await readLength();
    if (got >= want * 0.9) return true;
    console.warn(
      `[${step}] ⚠ insertText 后回读到 ${got} 字（期望 ${want}）→ 退回逐块输入`
    );
  } catch (e) {
    console.warn(`[${step}] insertText 失败（${e.message}）→ 退回逐块输入`);
  }

  // 兜底：清空后逐块输入（分块 + 随机间隔，模拟真人节奏）
  await page.evaluate(() => {
    const e = document.querySelector('.ql-editor, [contenteditable="true"]');
    if (e && e.focus) {
      e.focus();
      const sel = window.getSelection();
      if (sel && sel.selectAllChildren) {
        sel.selectAllChildren(e);
        sel.collapseToEnd();
      }
    }
  });
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  const chunks = text.match(/[\s\S]{1,40}/g) || [text];
  for (const c of chunks) {
    await page.keyboard.type(c);
    await humanDelay(delay[0], delay[1], step);
  }
  const got2 = await readLength();
  console.log(`[${step}] 正文已填（逐块输入，${want} 字，回读 ${got2} 字）`);
  return false;
}

/**
 * 上传入口点击 → filechooser 的通用重试封装。
 *
 * ⚠️ 2026-10-22 实测（微博 / 抖音图文 / 抖音视频**三个平台都踩过**）：
 *    坐标与成功那轮**完全一致**，但 filechooser 就是不弹（15s 超时）→ 整条线中止。
 *    处置：最多重试 3 次，每次**重新取入口坐标**再点（页面重排后旧坐标会落空）。
 *
 * @param {Object} page
 * @param {Function} locateEntry 每次重新定位上传入口，返回 {x,y} 或 null
 * @param {number} attempts 最多尝试次数
 * @returns {Promise<Object>} filechooser 对象
 * @throws {Error} 全部尝试都失败
 */
async function pickFileWithRetry(page, locateEntry, { attempts = 3, timeout = 15000, step = 'upload' } = {}) {
  let lastErr = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const entry = await locateEntry();
    if (!entry) {
      lastErr = '找不到上传入口';
      await humanDelay(600, 1400, step);
      continue;
    }
    try {
      const chooserP = page.waitForEvent('filechooser', { timeout }).catch((e) => {
        lastErr = e.message;
        return null;
      });
      await page.mouse.click(entry.x, entry.y);
      const chooser = await chooserP;
      if (chooser) return chooser;
      console.warn(`[${step}] 第 ${attempt} 次点上传入口没唤起文件选择器，重试`);
      await humanDelay(600, 1400, step);
    } catch (e) {
      lastErr = e.message;
      console.warn(`[${step}] 第 ${attempt} 次点上传入口异常（${e.message}），重试`);
      await humanDelay(600, 1400, step);
    }
  }
  throw new Error(
    `[${step}] 点上传入口 ${attempts} 次都没唤起文件选择器` +
      (lastErr ? `（最后一次：${lastErr}）` : '') +
      `—— 平台可能改版，或入口被遮挡。请人工核对页面后重试。`
  );
}

module.exports = { sleep, waitFor, waitForOrNull, humanDelay, fillLongText, pickFileWithRetry };
