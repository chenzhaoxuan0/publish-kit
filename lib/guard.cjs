// lib/guard.cjs — 交割护栏三件套（fillGuard / materialGuard / closeStalePages）
//
// ── 为什么集中 ────────────────────────────────────────────────────────
// 这三道护栏原来在平台脚本里各抄一份（微博/知乎想法/知乎视频…），抄一份漂移一份：
// 有一份把「渲染张数 ≥ count」当安全网（count 少算时是假安全网），有一份忘了排除
// 登录页。集中到这里，平台脚本只传参数。
//
// ── 通道无关 ──────────────────────────────────────────────────────────
// 接受两种容器（鸭子类型）：
//   · playwright context：pages() → Page[]（url() 同步、有 close()）
//   · ego 门面 ctx：pages() → 门面页[]（url() **异步**、无 close()）
//   · ego task（closeStalePages 用）：tabs() → [{page, url}]（url 是字符串、raw page 有 close()）
// 页对象的 url 一律 `await Promise.resolve(...)` 兼容两种形状 ——
// ⚠️ 直接对 ego 门面页用同步 `p.url()` 会拿到 Promise，正则永远不命中（护栏静默失效）。

/**
 * 收集容器的页列表 → [{page, url}]。三种容器统一成一种形状。
 */
async function listPages(container) {
  if (typeof container.tabs === 'function') {
    // ego task：raw tab 已带 url 字符串
    return (await container.tabs()).map((t) => ({ page: t.page, url: t.url || '' }));
  }
  const pages = await container.pages();
  const out = [];
  for (const p of pages) {
    out.push({ page: p, url: await Promise.resolve(p.url()).catch(() => '') });
  }
  return out;
}

/**
 * 交割护栏：填单脚本的终点是「发布按钮前」。如果页面上已经有文字，说明：
 *   (a) 上一轮已经交割过（人点了发布但页面还留着），或
 *   (b) 平台恢复了遗留草稿。
 * 两种情况都意味着「往一个脏表单里填单」——必须中止并让人处理。
 *
 * @param {Object} container 有 pages() 的容器（playwright ctx / ego 门面 ctx）
 * @param {Object} o
 * @param {string} o.urlPattern 只扫 URL 命中它的页（空 = 全部）
 * @param {string} o.excludePattern URL 命中它的页跳过（如登录页 passport）
 * @param {number} [o.threshold=10] 残留文字超过这个长度才算「有内容」（滤掉占位符）
 * @param {boolean} [o.force] 显式跳过（--force）
 * @param {boolean} [o.soft] 软模式：不抛错，返回残留列表（调用方结合台账判定
 *                 「没有待人点的交割稿 → 判为上次失败的残留，重载即清」时用）
 * @param {string} [o.label] 平台名（报错文案用）
 * @returns {Promise<string[]>} soft 模式返回残留片段列表；硬模式有残留直接抛
 */
async function fillGuard(container, o = {}) {
  const { urlPattern = '', excludePattern = '', threshold = 10, force = false, soft = false, label = '' } = o;
  if (force) {
    console.warn(`[guard] ⚠ 已用 --force 跳过交割护栏${label ? '（' + label + '）' : ''}`);
    return [];
  }
  const re = urlPattern ? new RegExp(urlPattern) : null;
  const ex = excludePattern ? new RegExp(excludePattern) : null;
  const dirty = [];
  for (const { page, url } of await listPages(container)) {
    if (re && !re.test(url)) continue;
    if (ex && ex.test(url)) continue;
    const filled = await page
      .evaluate(() =>
        [...document.querySelectorAll('textarea, [contenteditable="true"]')]
          .map((e) => ((e.value || e.textContent || '')).trim())
          .filter((s) => s.length > 0)
          .map((s) => s.slice(0, 30))
      )
      .catch(() => []);
    for (const s of filled) if (s.length > threshold) dirty.push(s);
  }
  if (dirty.length) {
    if (soft) {
      console.warn(
        `[guard] ⚠ ${label}页面上有残留文字 ${JSON.stringify(dirty)}` +
          '（soft 模式：由调用方结合台账判定是否为上次失败残留，重载即清）'
      );
      return dirty;
    }
    throw new Error(
      `[交割护栏] ${label}页面上已有内容，疑似已交割或平台恢复了遗留草稿：` +
        JSON.stringify(dirty) +
        '。请人工关闭该页后重跑；确认可弃加 --force。'
    );
  }
  return dirty;
}

/**
 * 物料守卫：上游生成脚本的 bug 曾把「undefined.」一路推进真实发布页，
 * 返工要删稿重发。正文出现 undefined / NaN / [object Object] 一律 FATAL。
 */
function materialGuard(text, { label = '' } = {}) {
  if (/undefined|NaN|\[object Object\]/.test(String(text || ''))) {
    throw new Error(`[物料守卫]${label ? ' ' + label : ''} 正文含 undefined/NaN/[object Object]，先修文件再发`);
  }
  return text;
}

/**
 * 清理遗留页：平台「草稿恢复」机制会让旧内容在 reload 后复活混入新填单。
 * 关掉 URL 命中的已存在页，调用方随后开新页。
 *
 * @param {Object} container playwright ctx / ego task（有 tabs()，raw page 可 close）
 * @param {string} urlPattern URL 正则（可用 (?!...) 负向前瞻排除要保留的页）
 * @returns {Promise<number>} 关掉的页数
 */
async function closeStalePages(container, urlPattern, { label = '' } = {}) {
  const re = new RegExp(urlPattern);
  let n = 0;
  for (const { page, url } of await listPages(container)) {
    if (!re.test(url)) continue;
    try {
      await page.close();
      n++;
    } catch {
      /* 关不掉就算了，不阻断 */
    }
  }
  if (n) console.log(`[guard] 清理${label ? label + ' ' : ''}遗留页 ${n} 个`);
  return n;
}

module.exports = { fillGuard, materialGuard, closeStalePages, listPages };
