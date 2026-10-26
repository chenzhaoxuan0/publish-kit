// lib/shot.cjs — 截图留档层：**截图失败只告警，不参与成败判据**
//
// ── 为什么截图不该参与成败判据 ──────────────────────────────────────
// 截图只是**给人看的留档**（事后人工核对封面/表单），判据全在 DOM 读数里：
// 「素材传上去了吗」看 input.files，「标题填进去了吗」看输入框的值。
// 但 Playwright 的 screenshot **默认超时 30s**，页面重 / 渲染异常 / 标签页被切走时
// 会抛超时异常 → 整条填单线作废。
//
// 实测事故（operation 工作区 2026-10-24）：三平台图都传完了，只因一次
// Page.captureScreenshot 超时，整轮发布被判失败、全部白跑。
// 代价对比：截图失败的代价 = 少一张留档；截图抛错的代价 = 一轮白跑。
//
// 所以定规矩：**截图失败 = 告警，不是失败**。本模块永不抛异常。
//
// ── 语义 ─────────────────────────────────────────────────────────────
//   · 永不抛异常（连 page 为空、目录建不出来都不抛）。
//   · 自带**短超时**（默认 6000ms）：把 page.screenshot 与一个定时器赛跑，
//     定时器先到即判失败。同时给 playwright 传同样的 timeout，避免它内部
//     挂着 30s 默认值不放。
//   · 超时后后台那个还没结束的 screenshot promise 挂着 .catch() 吞掉，
//     不会变成 unhandledRejection 把进程带崩。
//   · 失败**不删**已存在的旧截图（不能把上一次的留档搞没），但返回值里说明。
//
// ── 用法 ─────────────────────────────────────────────────────────────
//   const { shot } = require('../lib/shot.cjs');
//   await shot(p, SHOT);                 // 失败只告警，继续往下走
//   await shot(p, SHOT, { fullPage: false, timeoutMs: 8000 });

const fs = require('fs');
const path = require('path');

/** 默认短超时（ms）。比 playwright 的 30s 默认短得多——留档不值得等那么久。 */
const DEFAULT_TIMEOUT_MS = 6000;

/** 原因文本截断长度（避免把整段 playwright 堆栈糊到控制台上） */
const REASON_MAX = 120;

function errMsg(e) {
  const s = String((e && e.message) || e || '未知错误');
  return s.length > REASON_MAX ? s.slice(0, REASON_MAX) + '…' : s;
}

/**
 * 截一张图存盘。**永不抛异常。**
 *
 * @param {Object} page  Playwright page（需有 screenshot 方法）
 * @param {string} filePath  截图落盘路径（目录不存在会自动建）
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=6000] 短超时（ms）；也接受 playwright 风格的 `timeout`
 * @param {Object} [opts...]  其余参数原样透传给 page.screenshot（如 fullPage）
 * @returns {Promise<{ok: boolean, file: string, reason?: string, oldFileKept?: boolean}>}
 *          成功 { ok: true, file }；失败 { ok: false, file, reason, oldFileKept }
 */
async function shot(page, filePath, opts = {}) {
  const { timeoutMs, timeout, ...shotOpts } = opts || {};
  const eff = Math.max(1, Number(timeoutMs || timeout || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const file = filePath;

  const bail = (reason, oldFileKept = false) => {
    const tail = oldFileKept ? '（旧截图已保留）' : '';
    console.warn(`⚠ 截图失败（已忽略，不影响填单结果）：${reason}${tail}｜文件：${file}`);
    return { ok: false, file, reason, oldFileKept };
  };

  if (!file) return bail('未指定截图路径');
  if (!page || typeof page.screenshot !== 'function') return bail('page 不可用（没有 screenshot 方法）');

  // 截图前是否已存在同名文件（失败时不能把它删了）
  let oldFileKept = false;
  try {
    oldFileKept = fs.existsSync(file);
  } catch (_) {
    oldFileKept = false;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    return bail('截图目录创建失败：' + errMsg(e), oldFileKept);
  }

  let timer = null;
  // 后台这个 promise 永远带 catch：超时先到时它还没结束，
  // 裸挂着的 rejection 会变成 unhandledRejection 把进程带崩。
  const shotPromise = Promise.resolve()
    .then(() => page.screenshot({ ...shotOpts, path: file, timeout: eff }))
    .then(() => ({ ok: true, file }))
    .catch((e) => ({ ok: false, file, reason: errMsg(e), oldFileKept }));

  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, file, reason: `截图超时（${eff}ms 未返回）`, oldFileKept }),
      eff
    );
  });

  let result;
  try {
    result = await Promise.race([shotPromise, timeoutPromise]);
  } catch (e) {
    result = { ok: false, file, reason: errMsg(e), oldFileKept };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (result && result.ok) return { ok: true, file };
  return bail(result && result.reason ? result.reason : '未知错误', result ? !!result.oldFileKept : oldFileKept);
}

module.exports = { shot, DEFAULT_TIMEOUT_MS };
