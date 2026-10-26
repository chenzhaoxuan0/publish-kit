// lib/drivers/ego.cjs — ego-lite 通道门面（Playwright 形状 over ego taskSpace/Page API）
//
// ── 这是什么 ────────────────────────────────────────────────────────────
// ego lite（Citro Labs）是自带 Node 运行时的浏览器，`ego-browser nodejs` 跑脚本时
// 全局注入 taskSpace / takeOverTaskSpace / listTaskSpaces 等 helper。它的 Page API
// 与 Playwright **同形但不同名**（官方明言 "It is not Playwright"）。
//
// 本文件把 ego 的 taskSpace/Page 包装成「Playwright 形状的门面」，让 platforms/*.cjs
// **一份代码跑两条通道**（对应 docs/capability-matrix.md「四、路线图」的 driver 抽象）。
// 通道层的绝大部分实现**回灌自 operation/04_skills/ego-publish/lib/runtime.mjs**
// （2026-10-22~24 真机验证过的死页自愈 / 截图竞速 / filechooser 重试 / 交割护栏）。
//
// ── 门面覆盖的原语（与 lib/wait.cjs、lib/shot.cjs、lib/bigfile-upload.cjs 的鸭子面一致）──
//   url()(异步化) / evaluate / goto / waitForTimeout / waitForSelector
//   $(sel)→句柄{fill,click,inputValue,type} / locator(sel)→{first,nth,count}
//   mouse.click/move / keyboard.insertText/type/press
//   waitForEvent('filechooser')→waitForFileChooser / setInputFiles / screenshot(剥 timeout)
//
// ── 红线（内置，平台脚本无法绕过）──────────────────────────────────────
//   · 绝不调 task.finish()（会关掉表单页，用户就没法点发布了）；
//     交还用户只能由平台脚本在收尾显式调 session.handOff()。
//   · 绝不调 claimTaskSpace()（需要用户批准）。空间救不活 → 换 -r2/-r3 新空间名。
//   · takeOverTaskSpace 被拒原样抛（那是「空间已归用户」的信号，不是失败）。
//
// ⚠️ 本文件只在 `ego-browser nodejs` 运行时里真正可跑（依赖全局注入的 taskSpace 等）。
//    selftest 用假全局对象驱动同一份逻辑做纯逻辑验证。

const path = require('path');
const fs = require('fs');
const cfg = require('../config.cjs');
const { waitFor } = require('../wait.cjs');

const ROOT = cfg.ROOT;

// ── 日志（与 operation runtime.mjs 同格式：publish-all 靠它抓 spaceId）───
const t0 = Date.now();
function stamp() {
  return ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
}
function log(step, msg) {
  console.log(`[${stamp()}s] [${step}] ${msg}`);
}
function warn(step, msg) {
  console.log(`[${stamp()}s] [${step}] ⚠ ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 参数 ────────────────────────────────────────────────────────────────
// ego 运行时不透传 argv/env；bin/ego-run.ps1 的 wrapper 先把 globalThis.__OP_ARGS__
// 设好再 import 真正的脚本。名字沿用 operation 的 __OP_ARGS__（两边的 wrapper 语义一致）。

/** 读 wrapper 注入的参数；拿不到就抛错并给补法 */
function readArgs() {
  const a = globalThis.__OP_ARGS__;
  if (!a || typeof a !== 'object') {
    throw new Error(
      '[args] 拿不到参数 —— ego 通道必须经 bin/ego-run.ps1 运行：\n' +
        '  pwsh -NoProfile -File bin/ego-run.ps1 -Script platforms/<脚本> -ScriptArgs @{ ... }'
    );
  }
  return a;
}

// ── 路径 ────────────────────────────────────────────────────────────────
// ego 运行时的 cwd 是 ego lite 安装目录，一切路径必须绝对（按 publish-kit 根解析）。

/** 把可能相对的路径解析成绝对路径（相对 publish-kit 根，不是 cwd） */
function abs(p) {
  if (!p) return p;
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.join(ROOT, p);
}

/** Windows 下转正斜杠，给 ego 的 path 参数用 */
function slash(p) {
  return String(p).replace(/\\/g, '/');
}

/** 文件路径数组归一：绝对化 + 正斜杠（setInputFiles / chooser.setFiles 共用） */
function normFiles(files) {
  return [].concat(files).map((f) => slash(path.resolve(String(f))));
}

// ── 任务空间生命周期（回灌自 operation runtime.mjs，实测注释保留）────────

/** 空间名：`<prefix>-<平台>-<spaceKey>`（一期一个空间 —— handOff 之后拿不回控制权） */
function spaceNameFor(prefix, platform, spaceKey) {
  const key = String(spaceKey || '').trim();
  return key ? `${prefix}-${platform}-${key}` : `${prefix}-${platform}`;
}

/** 空间名的重试变体：xxx → xxx-r2 → xxx-r3 */
function spaceNameVariants(name, attempts = 3) {
  const base = String(name).replace(/-r\d+$/, '');
  const out = [];
  for (let n = 2; n <= attempts; n++) out.push(`${base}-r${n}`);
  return out;
}

/** 页面还活着吗：一次极轻的 evaluate，超时即判死（不抛，判据用） */
async function isPageAlive(rawPage, timeoutMs = 6000) {
  let timer = null;
  try {
    const probe = Promise.resolve(rawPage.evaluate(() => 1)).catch(() => null);
    const guard = new Promise((res) => {
      timer = setTimeout(() => res(null), timeoutMs);
    });
    const v = await Promise.race([probe, guard]);
    return v === 1;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 这个空间里还有没有活着的页（最多探前 max 个） */
async function hasAlivePage(task, { max = 3, step = 'space' } = {}) {
  let pages = [];
  try {
    pages = await task.pages();
  } catch (e) {
    warn(step, `读空间页面列表失败：${e.message}`);
    return false;
  }
  for (const p of pages.slice(0, max)) {
    if (await isPageAlive(p)) return true;
  }
  return false;
}

/**
 * 开空间 + 自愈（回灌自 operation runtime.mjs）。
 *
 * · 传了 spaceId → 接管它。接管被拒就**原样抛**（那是「空间归用户了」的信号）。
 * · 空间里全是死页 → 关掉死页后自动换新空间名（-r2/-r3）重开。
 *   换空间而不是 claim：claim 需要用户批准，换空间不用，且新空间是干净的。
 */
async function openSpaceAuto(name, { spaceId = null, attempts = 3 } = {}) {
  if (spaceId) {
    const t = await globalThis.takeOverTaskSpace(Number(spaceId));
    log('space', `接管空间 spaceId=${spaceId} (${t.name || name})`);
    if (await hasAlivePage(t)) return t;
    warn('space', `接管的空间 spaceId=${spaceId} 里没有活着的页（死页）→ 换新空间`);
  }
  const cands = [name, ...spaceNameVariants(name, attempts)];
  for (const cand of cands) {
    let t = null;
    try {
      t = await globalThis.taskSpace(cand);
    } catch (e) {
      warn('space', `空间 ${cand} 打不开（${e.message}）→ 换下一个`);
      continue;
    }
    if (await hasAlivePage(t)) {
      log('space', `空间 ${cand} (spaceId=${t.spaceId}, ownership=${t.ownership})`);
      return t;
    }
    // 全是死页 → 先关死页再换名（死页不关会跨天累积；关死页不丢在途数据）
    let closed = 0;
    try {
      for (const p of await t.pages()) {
        try {
          await p.close();
          closed++;
        } catch (_) {
          /* 关不掉就算了 */
        }
      }
    } catch (_) {
      /* 读不到页列表就算了 */
    }
    warn('space', `空间 ${cand} 里全是死页 → 换下一个空间名${closed ? `（已关掉 ${closed} 个死页）` : ''}`);
  }
  throw new Error(
    `[space] 空间 ${name} 及其备选（${spaceNameVariants(name, attempts).join('、')}）都不可用。` +
      `到 ego lite 窗口里手工确认这个空间的状态，或换一个 space_key 再跑。`
  );
}

// ── 选择器解析 ──────────────────────────────────────────────────────────
// ego 的元素操作要求选择器**唯一命中**（多匹配报歧义）。Playwright 默认取第一个。
// 门面的做法：先在页面里数命中数，>1 且不是联合选择器时追加 `>> nth=0`
// （ego 的 Playwright 兼容子集支持 `>> nth=N`）；联合选择器交给上层诚实报错。

async function resolveNth(rawPage, sel, idx) {
  const s = String(sel);
  if (idx > 0) return `${s} >> nth=${idx}`;
  // idx = 0：单命中直接用；多命中（含联合选择器）追加 nth=0 —— ego 对多命中必报歧义
  let n = 0;
  try {
    n = (await rawPage.evaluate((q) => document.querySelectorAll(q).length, s)) || 0;
  } catch {
    return s;
  }
  if (n > 1) return `${s} >> nth=0`;
  return s;
}

async function resolveSel(rawPage, sel) {
  return resolveNth(rawPage, sel, 0);
}

// ── Page 门面 ───────────────────────────────────────────────────────────

/**
 * 可选参转发器：把末尾的 undefined 实参**剥掉**再调。
 * ⚠️ 真机实测（2026-10-27，bento-grids 实测抓到）：ego 的 evaluate 等方法对
 *    「显式传入 undefined」敏感 —— `raw.evaluate(fn, undefined)` 的
 *    arguments.length 是 2，会走参数校验分支报
 *    "page.evaluate argument must be JSON-serializable"。
 *    playwright 习惯（page.click(sel) 不传 opts）在这里全部要经它转发。
 */
function fwd(obj, method, ...args) {
  const a = args.slice();
  while (a.length && a[a.length - 1] === undefined) a.pop();
  return obj[method](...a);
}

/**
 * 把 ego 的 Page 包成 Playwright 形状。
 * @param {Object} raw ego 原生 Page
 * @returns {Object} 门面 page（带 __egoDriver 标记与 __raw 逃生舱）
 */
function wrapPage(raw) {
  const page = {
    __egoDriver: true,
    __raw: raw,

    // ⚠️ ego 的 url()/title() 是**异步**的；门面保持 Promise。
    //    平台脚本统一 `await page.url()` —— playwright 的同步字符串被 await 是无操作，
    //    一行改动两通道通用。
    url() {
      return Promise.resolve(raw.url());
    },
    title() {
      return Promise.resolve(raw.title());
    },

    // evaluate：ego 与 playwright 同形（fn/string + 单 JSON 参数）。
    // 平台脚本的 evaluate 必须写成「无闭包捕获、至多一个参数」的形状 —— 两通道通用。
    // ⚠️ 必须经 fwd：零参调用（page.evaluate(() => …)）不能带 undefined 实参
    evaluate(fn, arg) {
      return fwd(raw, 'evaluate', fn, arg);
    },

    goto(url, opts) {
      return fwd(raw, 'goto', url, opts);
    },
    reload(opts) {
      return fwd(raw, 'reload', opts);
    },
    waitForTimeout(ms) {
      return raw.waitForTimeout(ms);
    },

    // 鼠标 / 键盘：ego 原生同形（click/move/down/up/wheel、press/type/insertText）。
    // 显式转发而不是直接引用对象 —— 防止 ego 内部依赖 this 绑定 + 剥尾部 undefined。
    mouse: {
      click: (...a) => fwd(raw.mouse, 'click', ...a),
      move: (...a) => fwd(raw.mouse, 'move', ...a),
      down: (...a) => fwd(raw.mouse, 'down', ...a),
      up: (...a) => fwd(raw.mouse, 'up', ...a),
      wheel: (...a) => fwd(raw.mouse, 'wheel', ...a),
    },
    keyboard: {
      // ⚠️ ego 的 type 不透传 opts（delay 未实测；真机节奏由条件等待 + waitForTimeout 保住，
      // playwright 路径不受本门面影响）
      type: (text) => raw.keyboard.type(text),
      insertText: (...a) => fwd(raw.keyboard, 'insertText', ...a),
      press: (...a) => {
        // 和弦键位归一：有修饰键时末位单字符转大写（'Control+a' → 'Control+A'）。
        // playwright 对大小写不敏感，ego 的 chord 解析未必 —— 门面统一成规范形。
        // ⚠️ 无修饰键的单字符（如 'a'）**不能**动 —— 大写等于按下 Shift。
        const chord = a[0];
        const parts = String(chord).split('+');
        if (parts.length > 1) {
          const last = parts[parts.length - 1];
          if (last.length === 1) parts[parts.length - 1] = last.toUpperCase();
        }
        return fwd(raw.keyboard, 'press', parts.join('+'), ...a.slice(1));
      },
      down: (...a) => fwd(raw.keyboard, 'down', ...a),
      up: (...a) => fwd(raw.keyboard, 'up', ...a),
      paste: (...a) => (raw.keyboard.paste ? fwd(raw.keyboard, 'paste', ...a) : Promise.reject(new Error('[ego] keyboard.paste 不可用'))),
    },

    // screenshot：ego **不接受 timeout 选项**（实测报 unknown option，内部 CDP 超时 15s）。
    // lib/shot.cjs 会传 timeout —— 门面在这里剥掉，只透传 ego 认识的选项。
    screenshot(opts = {}) {
      const { timeout, timeoutMs, path: p, ...rest } = opts || {};
      const egoOpts = {};
      if (p !== undefined) egoOpts.path = slash(p);
      for (const k of ['fullPage', 'clip', 'scale', 'raw']) {
        if (rest[k] !== undefined) egoOpts[k] = rest[k];
      }
      return raw.screenshot(egoOpts);
    },

    // waitForEvent('filechooser') → ego 的 waitForFileChooser。
    // 返回 chooser 门面 {setFiles, isMultiple}（lib/wait.cjs 的 pickFileWithRetry 消费）。
    waitForEvent(name, opts = {}) {
      if (name !== 'filechooser') {
        return Promise.reject(new Error(`[ego] 不支持等待事件 ${name}（仅支持 filechooser）`));
      }
      return raw.waitForFileChooser({ timeout: opts.timeout }).then((chooser) => ({
        isMultiple: () => (chooser.isMultiple ? !!chooser.isMultiple() : false),
        setFiles: (files) => chooser.setFiles([].concat(files).map((f) => slash(path.resolve(String(f))))),
      }));
    },
    waitForFileChooser(opts = {}) {
      return raw.waitForFileChooser(opts);
    },

    // 元素级文件上传：ego 原生 setInputFiles(sel, paths)。
    // ⚠️ 路径统一转正斜杠 + 绝对化（operation 实证的 ego 约定；cwd 是 ego 安装目录，
    // 相对路径会解析到 ego 的目录里去）
    async setInputFiles(sel, files) {
      const s = await resolveSel(raw, sel);
      return raw.setInputFiles(s, normFiles(files));
    },
    async fill(sel, value, opts) {
      const s = await resolveSel(raw, sel);
      return fwd(raw, 'fill', s, value, opts);
    },
    async click(sel, opts) {
      const s = await resolveSel(raw, sel);
      return fwd(raw, 'click', s, opts);
    },
    async press(sel, chord, opts) {
      const s = await resolveSel(raw, sel);
      return fwd(raw, 'press', s, chord, opts);
    },
    async selectOption(sel, value, opts) {
      const s = await resolveSel(raw, sel);
      return fwd(raw, 'selectOption', s, value, opts);
    },
    async focus(sel, opts) {
      const s = await resolveSel(raw, sel);
      return fwd(raw, 'focus', s, opts);
    },

    // waitForSelector：ego 的 visible 判据不可信（实测 example.com 的 h1 都能超时），
    // 判据换成 evaluate 存在性轮询，返回 $ 句柄。
    async waitForSelector(sel, opts = {}) {
      await waitFor(() => raw.evaluate((q) => !!document.querySelector(q), sel), {
        timeout: opts.timeout || 15000,
        interval: 300,
        step: 'waitForSelector',
        hint: `等不到元素：${sel}`,
      });
      return page.$(sel);
    },

    // $(sel) → 句柄或 null。句柄方法尽量走「坐标点击 + evaluate 读数」，
    // 避开 ego 的唯一性要求（联合选择器如 '.ql-editor, [contenteditable="true"]' 可能多命中）。
    async $(sel) {
      const exists = await raw.evaluate((q) => !!document.querySelector(q), sel).catch(() => false);
      if (!exists) return null;
      return makeHandle(sel);
    },

    // locator(sel) → {first, nth, count}（douyin 封面槽位、bigfile-upload 消费）
    locator(sel) {
      return {
        first: () => makeLocatorHandle(sel, 0),
        nth: (i) => makeLocatorHandle(sel, i),
        count: () => raw.evaluate((q) => document.querySelectorAll(q).length, sel).catch(() => 0),
      };
    },
  };

  /** 元素句柄（$(sel) 的返回值） */
  function makeHandle(sel) {
    return {
      __egoHandle: true,
      async inputValue() {
        return raw.evaluate((q) => {
          const el = document.querySelector(q);
          if (!el) return '';
          return el && 'value' in el ? String(el.value ?? '') : (el.textContent || '');
        }, sel);
      },
      async fill(v) {
        const s = await resolveSel(raw, sel);
        return raw.fill(s, v);
      },
      // 点击走坐标：先滚入视口再取中心点（避开 ego 多命中歧义）
      async click(opts) {
        const box = await centerOf(sel);
        if (!box) throw new Error(`[ego] 元素点不到（选择器未命中或零尺寸）：${sel}`);
        await fwd(raw.mouse, 'click', box.x, box.y, opts);
      },
      async type(text, opts) {
        await page.keyboard.type(text, opts);
      },
      async setInputFiles(files) {
        const s = await resolveSel(raw, sel);
        return raw.setInputFiles(s, normFiles(files));
      },
      async boundingBox() {
        return centerOf(sel);
      },
    };
  }

  /** locator 句柄（第 idx 个命中） */
  function makeLocatorHandle(sel, idx) {
    return {
      async setInputFiles(files) {
        const s = await resolveNth(raw, sel, idx);
        return raw.setInputFiles(s, normFiles(files));
      },
      async click(opts) {
        const box = await centerAt(sel, idx);
        if (!box) throw new Error(`[ego] locator(${sel})[${idx}] 点不到`);
        await fwd(raw.mouse, 'click', box.x, box.y, opts);
      },
      async fill(v) {
        const s = await resolveNth(raw, sel, idx);
        return raw.fill(s, v);
      },
      async count() {
        return raw.evaluate((q) => document.querySelectorAll(q).length, sel).catch(() => 0);
      },
      // 元素截图：滚入视口 → 取 rect → clip 截图（ego 没有 locator().screenshot()）
      async screenshot(opts = {}) {
        const box = await centerAt(sel, idx, { scroll: true, fullRect: true });
        if (!box) throw new Error(`[ego] locator(${sel})[${idx}] 截不到图`);
        const { timeout, timeoutMs, ...rest } = opts || {};
        const egoOpts = {};
        if (rest.path !== undefined) egoOpts.path = slash(rest.path);
        egoOpts.clip = {
          x: Math.max(0, Math.round(box.bx)),
          y: Math.max(0, Math.round(box.by)),
          width: Math.max(1, Math.round(box.bw)),
          height: Math.max(1, Math.round(box.bh)),
        };
        if (rest.fullPage !== undefined) egoOpts.fullPage = rest.fullPage;
        return raw.screenshot(egoOpts);
      },
    };
  }

  /** 第 idx 个命中的中心点；fullRect 时返回 {x,y,bx,by,bw,bh}（可先滚入视口）。
   *  ⚠️ ego 的 evaluate 不能捕获闭包变量 → sel/idx/scroll 打包成**单个 JSON 参数**传入。 */
  async function centerAt(targetSel, idx, { scroll = false, fullRect = false } = {}) {
    return raw
      .evaluate(
        (a) => {
          const el = document.querySelectorAll(a.q)[a.i];
          if (!el) return null;
          if (a.scroll && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return null;
          return {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            bx: r.x,
            by: r.y,
            bw: r.width,
            bh: r.height,
          };
        },
        { q: targetSel, i: idx, scroll }
      )
      .catch(() => null)
      .then((v) => (fullRect ? v : v ? { x: v.x, y: v.y } : null));
  }

  async function centerOf(sel) {
    return raw
      .evaluate((q) => {
        const el = document.querySelector(q);
        if (!el) return null;
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, sel)
      .catch(() => null);
  }

  return page;
}

// ── 会话 ────────────────────────────────────────────────────────────────

/**
 * 打开一个 ego 会话：空间（自愈）+ Playwright 形状的 ctx 门面。
 *
 * @param {Object} o
 * @param {string} o.platform 平台 key（空间名组成部分）
 * @param {string} [o.kind] 形态 image|video —— 抖音图文/视频是两个独立空间
 *        （playwright 通道靠同 Chrome 的多 tab + dyKind 标区分，ego 靠空间隔离）
 * @param {string} [o.spaceKey] 内容标识（空间名组成部分；一期一个空间）
 * @param {number|string} [o.spaceId] 台账里记过的空间 id（接管路径，必须显式传入）
 * @param {string} [o.prefix] 空间前缀（publish-kit 用 pk，与 operation 的 op 隔离）
 * @returns {Promise<Object>} {driver:'ego', ctx, task, spaceId, spaceName, handOff()}
 */
async function createEgoSession({ platform, kind, spaceKey, spaceId, prefix = 'pk' } = {}) {
  const name = spaceNameFor(prefix, kind ? `${platform}-${kind}` : platform, spaceKey);
  const task = await openSpaceAuto(name, { spaceId: spaceId || null });
  const rawPages = () => task.pages();

  const ctx = {
    // ⚠️ 返回**活页**的门面列表：死页绝不交出去（operation 2026-10-24 知乎事故的教训 ——
    //    死页的 evaluate 会挂到 ego 内部 15s CDP 超时，逐页探活代价可接受）。
    async pages() {
      const raw = await rawPages();
      const out = [];
      for (const p of raw.slice(0, 5)) {
        if (await isPageAlive(p)) out.push(wrapPage(p));
      }
      return out;
    },
    async newPage() {
      return wrapPage(await task.newPage());
    },
    // ego 下没有 CDP 会话（窗口尺寸调整这类 Browser 域操作不适用）。
    // 平台脚本对这段本来就有 try/catch（warn 后继续），这里抛出明确原因即可。
    async newCDPSession() {
      throw new Error('ego 通道不支持 CDP 会话（Browser 域操作已跳过，不影响填单）');
    },
  };

  return {
    driver: 'ego',
    ctx,
    task,
    spaceId: task.spaceId,
    // ⚠️ 自愈换名后 task.name 是真实空间名（如 xxx-r2）—— 报告实际值，不是请求值
    spaceName: task.name || name,
    // 交还用户（用户才能点「发布」）。只有**序列的最后一条命令**该调它 ——
    // handOff 之后 agent 不能自行接管，中间命令交还 = 后续命令撞墙。
    async handOff() {
      await task.handOff();
      log('space', `空间 ${task.name || name} 已交还用户（spaceId=${task.spaceId}）`);
    },
  };
}

/** 截图目录（config.publish.screenshot_dir，相对 publish-kit 根解析） */
function shotDir() {
  const dir = cfg.screenshotDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  readArgs,
  abs,
  slash,
  log,
  warn,
  sleep,
  spaceNameFor,
  spaceNameVariants,
  isPageAlive,
  hasAlivePage,
  openSpaceAuto,
  wrapPage,
  createEgoSession,
  shotDir,
};
