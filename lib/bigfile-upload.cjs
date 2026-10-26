// lib/bigfile-upload.cjs — CDP Chrome 大文件上传旁路
//
// 背景：Playwright / Patchright 在 setInputFiles / setFiles 时有一条 50MB 硬上限，
//   报错原文：`Cannot transfer files larger than 50Mb to a browser not co-located with the server`。
//   判定依据是「驱动进程与浏览器不同机」，而 connectOverCDP 连本机的 Chrome 一律按非同机处理，
//   所以哪怕浏览器就跑在本机，只要走 CDP 连，>50MB 的文件一律传不进去。
//   （内置 Browser 工具同样受限，upload_files 实测同一条 50MB 规则。）
//   十几 MB 的短视频碰不到这条线；2K 宣传片这类长视频必然踩。
//
// 方案：≤48MB 继续走 Playwright（保持既有行为不变，只在触发上限时才换路），
//   >48MB 改走浏览器进程原生 CDP `DOM.setFileInputFiles`——浏览器自己按本地绝对路径读盘，
//   不经过驱动传流，无任何大小限制，也不需要把几十 MB 数据搬进 Node 内存。
//
// 两条查找通道：
//   1) CDP `DOM.querySelectorAll` 直接在 document 上查（无 shadow DOM 的表单，秒中）；
//   2) 查不到则回退：让页面 JS 顺着 .shadowRoot 深走收集元素 → 换 objectId。
//      这条通道是为视频号 wujie 微前端（DOM 在 shadowRoot 里）准备的。
//      注意：CDP 的 pierce 参数在这种「自定义元素 + shadowRoot」结构上实测拿不到 nodeId，
//      别在它身上耗时间。
const fs = require('fs');

const MB = 1024 * 1024;
// 留 2MB 余量：贴边判定容易在文件系统与内存换算上翻车，宁可早切换
const LIMIT = 48 * MB;

// 在页面内收集匹配选择器的元素，显式深走 shadowRoot（最多 12 层）。
// shadowRoot 与 document 同 realm，页面 JS 可以直接顺着 .shadowRoot 走到底，
// 拿到的元素对象再用 Runtime.evaluate 换出 objectId。
const DEEP_WALK = (selector, index) => `(() => {
  const sel = ${JSON.stringify(selector)}, idx = ${index};
  const out = [];
  const collect = (scope, depth) => {
    if (depth > 12) return;
    try { for (const el of scope.querySelectorAll(sel)) out.push(el); } catch (e) {}
    let all;
    try { all = scope.querySelectorAll('*'); } catch (e) { return; }
    for (const el of all) { if (el.shadowRoot) collect(el.shadowRoot, depth + 1); }
  };
  collect(document, 0);
  return out[idx] || null;
})()`;

// 原生 CDP 直传：绕过驱动的 50MB 上限，浏览器进程按路径自行读盘
async function cdpSetFiles(page, selector, index, file) {
  const cdp = await page.context().newCDPSession(page);
  try {
    // 通道 1：普通 DOM（无 shadow），直接查 nodeId，最快
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const hit = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    if (hit && hit.nodeIds && hit.nodeIds.length > index) {
      await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: hit.nodeIds[index] });
      return 'nodeId';
    }
    // 通道 2：shadow DOM——页面 JS 深走 shadowRoot 取元素 → objectId 通道
    const res = await cdp.send('Runtime.evaluate', {
      expression: DEEP_WALK(selector, index),
      returnByValue: false,
    }).catch(() => null);
    const objectId = res && res.result && res.result.objectId;
    if (!objectId) {
      throw new Error(`CDP 直传失败：${selector} 第 ${index + 1} 个元素定位不到（已含 shadowRoot 深搜）`);
    }
    await cdp.send('DOM.setFileInputFiles', { files: [file], objectId });
    return 'objectId';
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// 视频上传统一入口。小文件走 Playwright 原路径，大文件自动切 CDP 直传。
// 返回实际使用的通道名，便于日志追溯。
async function setVideoFile(page, selector, file, index = 0, opts = {}) {
  const timeout = opts.timeout || 20000;
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { throw new Error('视频文件不存在: ' + file); }

  // ⚠️ ego 通道：CDP 直传不可用（page.cdp 逃生舱只放行 Page/Runtime/DOM/Network/Input 域，
  //    Browser 域的窗口/会话操作进不去；且 ego 的 chooser.setFiles 大文件未实测）。
  //    与 operation douyin-video.mjs 同口径：不硬闯，明确报错让人接管。
  if (page && page.__egoDriver) {
    if (size > LIMIT) {
      throw new Error(
        `ego 通道未实测 >48MB 视频直传（${(size / MB).toFixed(1)}MB）。` +
          `两个选择：(a) 改用 CDP Chrome 通道（config.yaml runtime.driver: playwright）；` +
          `(b) 人工接管该 TaskSpace 手动上传后继续。本次填单中止，未交割半成品。`
      );
    }
    await page.locator(selector).first().setInputFiles(file, { timeout });
    return 'ego';
  }

  if (size > LIMIT) {
    await cdpSetFiles(page, selector, index, file);
    console.log(
      `视频 ${(size / MB).toFixed(1)}MB 超过 50MB 传输上限，已改走 CDP 原生直传: ${require('path').basename(file)}`
    );
    return 'cdp';
  }

  // 注意：用 locator 解析动作，不要用 waitForSelector → handle.setInputFiles。
  // handle 路径对 shadowRoot 内的元素会误报 detached（wujie 微前端实测：节点持续连接仍 100% 失败，
  // locator 路径 100% 成功）。
  await page.locator(selector).first().setInputFiles(file, { timeout });
  return 'playwright';
}

// 原生文件对话框已打开时的大文件接管。
// 有些平台（如微博上传页）UI 必须走「点按钮 → 原生 filechooser」这条路径，
// 直接往 input 塞文件根本不触发上传；而 Playwright 的 chooser.setFiles 又和 setInputFiles
// 共用 50MB 上限。
// 于是：照常点按钮接住 chooser 事件（保证 UI 流程被触发），
// 但不用 chooser.setFiles 赋值，改用原生 CDP 对同一个 file input 下 DOM.setFileInputFiles，
// 由浏览器进程自己按路径读盘。小文件返回 null，调用方照旧用 chooser.setFiles。
async function resolveOpenFileChooser(page, file, selector = 'input[type=file]') {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { throw new Error('文件不存在: ' + file); }
  if (size <= LIMIT) return null;

  // ego 通道：大文件无 CDP 接管路径（同 setVideoFile 的口径），明确报错转人工
  if (page && page.__egoDriver) {
    throw new Error(
      `ego 通道未实测 >48MB 文件直传（${(size / MB).toFixed(1)}MB）。` +
        `改用 CDP Chrome 通道（runtime.driver: playwright）或人工接管上传。`
    );
  }

  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    if (!nodeIds || !nodeIds.length) throw new Error('CDP 接管 filechooser：页面内未找到 file input');
    await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: nodeIds[0] });
    return 'cdp';
  } finally {
    await cdp.detach().catch(() => {});
  }
}

module.exports = { setVideoFile, cdpSetFiles, resolveOpenFileChooser, LIMIT, MB };
