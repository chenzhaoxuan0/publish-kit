// zhihu-pin.cjs — 知乎「想法」图文发布（填单脚本）
//
// 用途：把一批已生成好的图片 + 正文填进知乎创作中心的「想法」编辑器，
//   停在「发布」按钮前，由用户人工点。
//
// 用法：
//   node platforms/zhihu-pin.cjs --media <dir> --body-file <简介.txt> [--count 6]
//                              [--title "标题并入首行"] [--force]
//   --media      图片目录，按 img-01.png 起连续命名
//   --body-file  纯文本正文文件
//   --title      标题：默认填「标题」字段（想法 V2 表单的 name="title" textarea）
//   --title-in-body  退回旧行为：标题并入正文首行（默认不启用）
//   --count      实际张数（默认 6）
//   --force      跳过「交割护栏」。护栏检测到页面上已有文字就中止，是为了不污染真实发布页。
//   --manual-images
//                跳过自动配图，只自动填正文、截图、停在「发布」前，配图由人工在编辑器里补
//                （默认不启用）。自动传图链路 2026-10-19 晚已修通，根因是**判据数错了容器**
//                （见坑位⑦⑧），不是上传失败。
//
// 流程：https://www.zhihu.com/creator 创作中心 → 「分享此刻的想法…」编辑器（常驻页面）
//   → 点工具栏图片按钮 → 三层 UI 上传 → 逐张点选预览 → 「插入图片」
//   → Draft.js contenteditable 键盘输入正文（话题 # 走联想面板）
//   → 停「发布」前
//
// 依赖：
//   - 浏览器通道用 patchright，经 CDP 连一个已经登录好的浏览器。CDP 地址取自
//     config.yaml 的 runtime.cdp_url；环境变量 CDP_URL 可临时覆盖。
//     依赖装不上或浏览器没起时，看 bin/login.cjs 与 bin/doctor.cjs。
//   - 结尾截图落到 config.yaml 的 publish.screenshot_dir 目录。
//
// 契约：只做填单，绝不点击「发布」。
//
// 本工具不对特定平台做自动化；是否接入某平台由使用者自行判断并承担后果。
//
// 坑位（经实测确定）：
//   ① /creator/pin 是 404，想法无独立路由，只能在创作中心首页就地发。
//   ② 图片 input 是 visibility:hidden（offsetParent === null），不能靠可见性筛，
//      按 accept*="image" + [multiple] 定位。
//   ③ 正文编辑器是 Draft.js .public-DraftEditor-content（contenteditable），
//      必须键盘输入触发 Draft 内部状态；直接设 innerHTML 不落 React state。
//   ④ 遗留知乎标签页可能带旧草稿，交割护栏：全量 contenteditable >10 字即视为已交割。
//   ⑤ .public-DraftEditor-content 常驻 DOM 但未激活时 getBoundingClientRect() = 0×0，
//      必须先进编辑态。⚠️ 2026-10-26 修正：**点 placeholder 文字元素（「分享此刻的想法…」）
//      在当前 UI 上已完全失效**——它匹配到的是外层容器 DIV，点它不激活编辑器（恒 0 宽）；
//      可靠入口 = 正文区文案恰为「发想法」的**按钮**（BUTTON 75×32），
//      且第一次点击有概率落空 → **最多重试 3 次**（无人值守不能靠人重跑）。
//   ⑥ 编辑态下真正的发布按钮文案是「发布」（「发想法」在编辑态下会收成 0 宽占位）；
//      但**激活编辑器**要找「发想法」按钮——两者不矛盾：**入口找「发想法」，发布找「发布」**。
//   ⑦ **知乎想法的图不在 Draft.js 编辑器容器里**。上传成功后图落在编辑器**上方**的
//      独立图集区：div.DraggableTags > .DraggableTags-tag > img（src 是
//      pic-private.zhihu.com，草稿态私有 CDN，natural 尺寸=原图，如 1440x1920）。
//      判据必须数**图集区**里的 <img> 并按 src 去重：
//        ✗ 数 .public-DraftEditor-content 内的 <img> → 恒 0（旧判据，误报「未落稿」）
//        ✗ 数全页缩略图 → 恒 ≥count，侧栏推荐位造假阳性
//      10-19 期就是这个错判据导致误以为「传图链路不通」，白降级了一期人工补图。
//   ⑧ 判据还要**逐张对上源图**：读 PNG 头拿每张源图的宽高，图集里必须能一一匹配
//      （宽高全等优先，退而求其次宽高比一致），否则「平台默认活动推广图顶替了我的图」
//      这类假阳性照样漏过。
//   ⑨ 想法 V2 表单有 TitleArea > textarea[name="title"]（maxLength=-1、非必填）。
//      标题应填这个字段，正文首行不要重复标题。
//   ⑩ 正文必须用 keyboard.insertText 插入，**不能**用 keyboard.type 逐字打：
//      每敲一个「#」都会弹出知乎话题联想面板，平台会把我们打的词顶替成热榜话题
//      （实测「#英伟达 」→「#书单推荐」，DOM 里还落成 <a class="zed-topic">），
//      正文被静默污染。insertText 不派发按键，联想面板不触发。
//
// ── 2026-10-22 内化（横向能力层接入）新增坑位 ────────────────────────
//   ⑪ 点「本地图片上传」后 filechooser **偶发唤不起来**：坐标与成功那轮完全一致，
//      文件选择器就是不弹（微博 / 抖音图文 / 抖音视频三平台都踩过）→ 整条线中止。
//      处置：lib/wait.cjs 的 pickFileWithRetry —— 最多点 3 次，每次**重新取入口坐标**
//      （弹窗重排后旧坐标会落空）。
//   ⑫ 正文改用 lib/wait.cjs 的 fillLongText（insertText + 回读校验 + 对不上自动退回逐块输入）。
//      ⚠ **它的兜底逐块输入在 Draft.js 上会触发话题联想**（同坑位⑩）——所以这里的
//        「兜底」只当保险丝用：填完仍走本脚本原有的**严格回读校验**，不一致就抛错，
//        **绝不**把被平台改写的正文交割出去（宁可炸掉，也不带脏稿交割）。
//   ⑬ 体检（preflight）必须在 connectOverCDP **之前**；日志层是**旁路**，只多打不改原输出。
//      图集张数判据用 preflight 的 mediaDir + declaredCount（它的 listImages 已认 img-01.png
//      这套命名）；「目录里张数 > 声称张数」在体检之外单独提醒（多的图不会被传）。
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config.cjs');
const { chromium } = require('patchright');
// 2026-10-22 内化：等待层（长文本一次性插入 / 上传入口重试）+ 日志层 + 起浏览器前体检
const { sleep, fillLongText, pickFileWithRetry } = require('../lib/wait.cjs');
const { create } = require('../lib/log.cjs');
const { preflight, listImages } = require('../lib/preflight.cjs');
// 2026-10-26 内化：截图留档层——截图失败只告警，不参与成败判据
const { shot } = require('../lib/shot.cjs');

// 每平台独立日志（旁路）。异常路径也要收尾，否则失败时反而没有留痕。
let log = null;

// 截图统一落 config.yaml 的 screenshot_dir（不写死在脚本旁边，也不留在这个仓库里）
const shotPath = (name) => path.join(cfg.screenshotDir(), name);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      // 布尔开关（如 --manual-images）：后面不跟值时置 true，
      // 避免把下一个 --xxx 误当成它的值吞掉。
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(argv[i]);
  }
  return out;
}

// PNG 头读宽高（不引第三方依赖）：源图尺寸是「图到底落没落对」的关键判据（坑位⑧）
function readPngSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;   // 不是 PNG
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    return (w > 0 && h > 0) ? { w, h, ratio: w / h } : null;
  } catch (e) { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// 把图集里的图与源图一一对上：优先「宽高完全相同」，其次「宽高比一致」
// 返回 { exact, ratio, matched, missing } —— missing>0 = 有源图没找到对应落稿图
function matchStripToSources(items, srcDims) {
  const used = new Set();
  let exact = 0, ratio = 0;
  const dims = srcDims.filter(Boolean);
  for (const d of dims) {
    let hit = -1;
    for (let i = 0; i < items.length; i++) {
      if (used.has(i)) continue;
      const it = items[i];
      if (it && it.w === d.w && it.h === d.h) { hit = i; break; }
    }
    if (hit >= 0) { used.add(hit); exact++; continue; }
    for (let i = 0; i < items.length; i++) {
      if (used.has(i)) continue;
      const it = items[i];
      if (!it || !it.w || !it.h) continue;
      if (Math.abs(it.w / it.h - d.ratio) / d.ratio < 0.01) { hit = i; break; }
    }
    if (hit >= 0) { used.add(hit); ratio++; }
  }
  return { exact, ratio, matched: exact + ratio, missing: dims.length - exact - ratio };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.media) throw new Error('缺 --media <dir>');
  if (!args['body-file'] || !fs.existsSync(args['body-file'])) throw new Error('缺 --body-file');
  const body = fs.readFileSync(path.resolve(args['body-file']), 'utf-8').trim();
  // 标题落位（坑位⑨）：想法 V2 表单有 name="title" 的 textarea，标题应填那里，
  // 正文首行不再重复标题。--title-in-body 可退回旧行为（标题并入正文首行）。
  const title = args.title ? String(args.title) : '';
  const titleInBody = !!args['title-in-body'];
  let text = titleInBody && title ? `${title}\n${body}` : body;
  const count = parseInt(args.count || '6', 10);
  const media = path.resolve(args.media);
  const imgs = Array.from({ length: count }, (_, i) => path.join(media, `img-${String(i + 1).padStart(2, '0')}.png`));
  imgs.forEach((f) => { if (!fs.existsSync(f)) throw new Error('图片缺失: ' + f); });
  // 源图宽高：后面「图落对了没」的判据要用（坑位⑧）
  const srcDims = imgs.map((f) => readPngSize(f));
  const noDim = srcDims.filter((d) => !d).length;
  if (noDim) console.log(`⚠ ${noDim}/${count} 张源图读不到尺寸（非 PNG？），判据退化为宽高比`);
  // 物料守卫：正文出现 undefined/NaN 即 FATAL（曾经有上游生成脚本的 bug 把「undefined。」
  // 一路推进真实发布页，返工要删稿重发，这个洞不值得再踩一次）
  if (/undefined|NaN|\[object Object\]/.test(title + text)) throw new Error('[物料守卫] 正文含 undefined/NaN，先修文件再发');

  // 2026-10-22：每平台独立日志（旁路，只多打不改原有 console 输出）
  log = create({ platform: 'zhihu-pin', kind: 'image' });

  // 2026-10-22：起浏览器**之前**的体检（坑位⑬）。契约：不过就抛，别 catch 后继续。
  //   判据：①图集目录里实际有几张 vs 声称要传几张（mediaDir + declaredCount）
  //        ②正文里的 undefined / NaN / [object Object] ③正文长度区间 ④标题长度
  //   ⚠ 不设 titleMax：想法 V2 的标题框 maxLength=-1（非必填），没有字数上限口径；
  //     bodyMax 2000 是粗筛（实测 1338 字正常通过，2026-10-22 ego 通道），不承担平台上限语义。
  preflight({
    platform: 'zhihu-pin',
    mediaDir: media,
    declaredCount: count,
    title: title,
    bodyText: text,
    // ⚠ bodySoftMax 2000 是**粗筛**不是平台口径（实测 988 字正常）——
    //   知乎想法的平台硬上限本仓库没有实测记录，用**软线**（超了只告警）。
    //   硬闸必须有实测依据，否则口径一改就误拦合法稿件。
    limits: { bodySoftMax: 2000, bodyMin: 1 },
  });
  // 体检之外再看一眼「目录里张数 > 声称张数」：多出来的图不会被传（只按 --count 取前 N 张），
  // 但要提醒一声，免得以为 9 张都上去了。
  const mediaInfo = listImages(media);
  const actual = mediaInfo.exists ? mediaInfo.files.length : 0;
  if (actual > count) console.log(`⚠ 目录里有 ${actual} 张图，本次只传前 ${count} 张（--count 指定）`);
  log.step('起浏览器前体检', `图集 ${actual} 张 / 声称 ${count} 张 + 正文长度 + undefined 守卫`);

  const browser = await chromium.connectOverCDP(process.env.CDP_URL || cfg.cdpUrl(), { timeout: 15000 });
  const ctx = browser.contexts()[0];

  // 交割护栏 + 关旧页：**只针对想法页**（2026-10-19 修）
  //   原来这里扫的是「所有知乎标签页」，于是两件事都会出事：
  //   ① 视频投稿页（upload-video）里已填的标题/介绍会被当成「已交割的想法」而误拦；
  //   ② 更糟——后面那行「关掉所有知乎标签页」会**连同已填好的视频表单一起关掉**。
  //   现在：只管非 upload-video 的知乎页（=想法页），upload-video 页原样保留。
  const pinTabs = ctx.pages().filter((x) => /zhihu\.com/.test(x.url()) && !/upload-video/.test(x.url()));
  const keepVideo = ctx.pages().filter((x) => /zhihu\.com\/upload-video/.test(x.url()));
  if (keepVideo.length) console.log('检测到 ' + keepVideo.length + ' 个知乎视频投稿页（已填表单），原样保留不碰');
  if (!process.argv.includes('--force')) {
    for (const t of pinTabs) {
      const filled = await t.evaluate(() => [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .map((e) => ((e.value || e.textContent || '')).trim()).filter((s) => s.length > 10)
        .map((s) => s.slice(0, 30))).catch(() => []);
      if (filled.length) throw new Error('[交割护栏] 知乎想法页已有文字（疑似已交割或遗留草稿）:' + JSON.stringify(filled) + '。请人工关闭该标签页后重跑；确认可弃加 --force。');
    }
  }
  for (const t of pinTabs) await t.close().catch(() => {});
  const p = await ctx.newPage();
  await p.goto('https://www.zhihu.com/creator', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(9000);
  // 登录态判定：URL 可靠但登录墙跳转更直接——判页面上「发想法」按钮在不在（未登录无此按钮）
  const loggedIn = await p.evaluate(() => [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '发想法' && b.getBoundingClientRect().width > 0));
  if (!loggedIn) throw new Error('知乎未登录或未加载完成（无「发想法」按钮）: ' + p.url());
  console.log('知乎创作中心已开:', p.url(), '✓ 登录态正常');

  // 0) 激活想法编辑器（坑位⑤）
  // ⚠️ 2026-10-26 实测修正（移植自 ego 通道 04_skills/ego-publish/platforms/zhihu.mjs，
  //    那边 2026-10-20 就已定位、2026-10-22 补了重试；本仓库漏同步 → B 通道在当前
  //    知乎 UI 上**恒 0 宽直接 FATAL**，降级等于白跑）：
  //    「点 placeholder 文字元素」这条路在**当前的知乎页面上已完全失效**——
  //    「分享此刻的想法...同步到圈子发想法」只是一段 placeholder 文本，
  //    匹配到的是外层容器 DIV，点它**不激活编辑器**（编辑器保持 0×0）。
  //    **可靠入口是正文区那个文案恰为「发想法」的按钮**（BUTTON，75×32）。
  // ⚠️ 第一次点击**有概率不生效**（页面状态残留时点击落空）→ **最多重试 3 次**，
  //    每次都重新探测入口 —— 无人值守的夜间任务不能靠人重跑一次。
  let editorWidth = 0;
  for (let attempt = 1; attempt <= 3 && editorWidth === 0; attempt++) {
    const activated = await p.evaluate(() => {
      // 已展开就别再点（点「发想法」会把已开的编辑器收起来）
      const ed0 = document.querySelector('.public-DraftEditor-content, [contenteditable="true"]');
      if (ed0 && ed0.getBoundingClientRect().width > 0) return { alreadyOpen: true };
      // 优先：文案恰为「发想法」的按钮
      for (const el of document.querySelectorAll('button')) {
        if ((el.textContent || '').trim() === '发想法' && el.getBoundingClientRect().width > 0) {
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, how: '发想法按钮' };
        }
      }
      // 兜底：placeholder 文字元素（老版页面）
      for (const el of document.querySelectorAll('div,span,button,a')) {
        const t = (el.textContent || '').trim();
        if (t === '分享此刻的想法...' || t === '分享此刻的想法…' || (t.length > 4 && t.length < 20 && /分享此刻的想法/.test(t))) {
          const r = el.getBoundingClientRect();
          if (r.width > 20 && r.height > 5) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, how: 'placeholder文字' };
          }
        }
      }
      return null;
    });

    if (activated && activated.alreadyOpen) {
      console.log('想法编辑器已处于编辑态');
      editorWidth = 1;
      break;
    }
    if (!activated) {
      console.log(`第 ${attempt} 次没找到「发想法」入口，重试`);
      await sleep(1200);
      continue;
    }
    console.log(`激活编辑器（${activated.how}）:`, JSON.stringify(activated));
    await p.mouse.click(activated.x, activated.y);
    await sleep(2500);
    const w = await p.evaluate(() => {
      const ed = document.querySelector('.public-DraftEditor-content, [contenteditable="true"]');
      return ed ? Math.round(ed.getBoundingClientRect().width) : 0;
    });
    if (w > 0) { editorWidth = w; break; }
    console.log(`第 ${attempt} 次点击没让编辑器展开（仍 0 宽），重试`);
    await sleep(1200);
  }

  if (editorWidth === 0) {
    throw new Error(
      '想法编辑器连点 3 次都没展开（0 宽），未能进入编辑态。\n' +
      '  已尝试「发想法」按钮与 placeholder 文字两种入口。\n' +
      '  请人工在 CDP Chrome 里点一下「发想法」看能否展开，再决定要不要改选择器。'
    );
  }
  // 验证编辑器已展开
  const edOpen = await p.evaluate(() => {
    const ed = document.querySelector('.public-DraftEditor-content, [contenteditable="true"]');
    const r = ed ? ed.getBoundingClientRect() : { width: 0, height: 0 };
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('编辑器尺寸:', JSON.stringify(edOpen));

  // 0.5) 标题落「标题」字段（坑位⑨）
  //     想法 V2 表单里 TitleArea > textarea[name="title"]，maxLength=-1（非必填）。
  //     标题填这里，正文首行不再重复；找不到这个框才退回「标题并入正文首行」。
  if (title && !titleInBody) {
    const ta = await p.$('textarea[name="title"], textarea[placeholder="标题"]');
    if (ta) {
      await ta.fill(title);
      await sleep(600);
      const v = await ta.inputValue().catch(() => '');
      console.log('标题字段已填:', JSON.stringify(v), v === title ? '✓' : '✗ 回读不一致');
      log.step('标题', v === title ? '已填（回读✓）' : '回读不一致');
      if (v !== title) throw new Error('标题字段回读不一致，疑似 React 未接收（填的是 "' + v + '"）');
    } else {
      text = `${title}\n${text}`;
      console.log('⚠ 未找到「标题」输入框，标题退回并入正文首行');
    }
  }

  // 图集区读数（坑位⑦）：知乎想法的图在编辑器**上方**的 div.DraggableTags 里，
  //   不在 .public-DraftEditor-content 里。按 src 去重（每张图渲染两层）。
  const readStrip = () => p.evaluate(() => {
    const strip = document.querySelector('.DraggableTags');
    const scope = strip || document.querySelector('.WriteArea') || document.body;
    const seen = new Map();
    for (const im of scope.querySelectorAll('img')) {
      const src = im.currentSrc || im.src || '';
      if (!src || !im.naturalWidth || im.naturalWidth < 200) continue;   // 头像/图标不算
      const key = src.split('?')[0];
      if (!seen.has(key)) seen.set(key, { w: im.naturalWidth, h: im.naturalHeight, box: Math.round(im.getBoundingClientRect().width) });
    }
    return { hasStrip: !!strip, total: seen.size, items: [...seen.values()] };
  });

  // 1) 传图（--manual-images 时整段跳过，见文件头说明）
  if (!args['manual-images']) {
    // 1) 传图：三层 UI（经实测确定，这是「图片没上去」的真正根因链）：
    //    L1 图片工具栏按钮（icon BUTTON，无文本）→ L2 Popover「上传图片」→ L3 Modal 内
    //    「本地图片上传」→ 才触发 filechooser。
    //    隐藏 input 直接 setInputFiles **完全无效**（编辑器内 0 图，走满 60s 也不落地）。
    // ── 逐张插入（2026-10-21 重构）────────────────────────────────────────
    //  原实现：8 张一次上传 → 在 Modal 网格里逐张点选 → 一次「插入图片」。
    //  实测问题：Modal 网格每行最后一张会被滚动裁切，点选落在裁切区外 → 该图没被选中
    //  → 插入数随机少 1~2 张（实测 7/8、6/8，两次跑结果不同），脚本判据报错但图确实没进去。
    //  现实现：**一张一张插**（每张独立走一遍三层 UI → filechooser → 点选 → 插入），
    //  每张都验「图集区计数必须 +1」，不达标就重试该张（上限 3 次）。
    //  单张插入没有网格滚动问题，且每张都有独立判据，失败可定位可重试。
    //
    //  L1 图片工具栏按钮（icon BUTTON，无文本）：每张插入前重新定位——
    //  图集区随插入变高，编辑器整体下移，按钮坐标会变。
    const findPicBtn = async () => {
      // 2026-10-21 修定位锚点：插图后**图集区变高**，工具栏图标整体下移，
      // 旧窗口（编辑器 top+180px）会把工具栏排除在外 → 找不到按钮。
      // 新锚点：编辑器页脚行里的「同步到圈子」——工具栏图标与它同一行，位置稳定。
      // 先把编辑器滚进视口，保证坐标落在可视区。
      await p.evaluate(() => {
        const ed = document.querySelector('.public-DraftEditor-content');
        if (ed) ed.scrollIntoView({ block: 'center' });
      });
      await sleep(700);
      return p.evaluate(() => {
        const small = [...document.querySelectorAll('button')].map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width >= 15 && r.width <= 30 && r.height >= 15 && r.height <= 30);
        let pool = small, anchor = null;
        const sync = [...document.querySelectorAll('div,span,button,a')].find(e => {
          const t = (e.textContent || '').trim();
          if (!/^同步到圈子/.test(t)) return false;
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (sync) {
          const sr = sync.getBoundingClientRect();
          const row = small.filter(({ r }) => Math.abs((r.y + r.height / 2) - (sr.y + sr.height / 2)) < 30 && r.x < sr.x);
          if (row.length) { pool = row; anchor = '同步到圈子'; }
        }
        if (!pool.length) {
          // 回退：编辑器同列 + 更宽的纵向窗口
          const ed = document.querySelector('.public-DraftEditor-content');
          if (!ed) return null;
          const eb = ed.getBoundingClientRect();
          pool = small.filter(({ r }) => r.x > eb.x - 60 && r.x < eb.x + eb.width && r.y > eb.y - 5 && r.y < eb.y + 700);
          anchor = '编辑器列';
        }
        if (!pool.length) return null;
        pool.sort((a, b) => a.r.x - b.r.x);
        // 工具栏顺序 # / 表情 / 图片 / 视频 / 图表 —— 图片是第 3 个
        const r = pool[Math.min(2, pool.length - 1)].r;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, n: pool.length, anchor };
      });
    };


    // 插入单张：L1 工具栏 → L2 Popover「上传图片」→ L3 Modal「本地图片上传」→ filechooser
    //          → 等预览 → 点选预览 → 点「插入图片」
    const insertOne = async (file) => {
      const picBtn = await findPicBtn();
      if (!picBtn) throw new Error('未找到图片工具栏按钮（icon 定位失败，页面改版？）');
      await p.mouse.click(picBtn.x, picBtn.y);
      await sleep(2000);

      const upPos = await p.evaluate(() => {
        const el = [...document.querySelectorAll('button,div[role=button],a,span,li')]
          .find((x) => (x.textContent || '').trim() === '上传图片' && x.getBoundingClientRect().width > 10);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!upPos) throw new Error('L1 已点开但未找到 Popover「上传图片」（页面改版？）');
      await p.mouse.click(upPos.x, upPos.y);
      await sleep(2500);

      const localPos = await p.evaluate(() => {
        const el = [...document.querySelectorAll('button,div[role=button],a,span,li,div')]
          .find((x) => (x.textContent || '').trim() === '本地图片上传' && x.getBoundingClientRect().width > 10);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!localPos) throw new Error('L2 已点开但未找到 Modal「本地图片上传」（页面改版？）');
      // 2026-10-22（坑位⑪）：点「本地图片上传」后 filechooser 偶发唤不起来 → 整条线中止。
      //   pickFileWithRetry：最多点 3 次，每次**重新定位入口**（弹窗重排后旧坐标会落空）。
      const locateLocal = async () => p.evaluate(() => {
        const el = [...document.querySelectorAll('button,div[role=button],a,span,li,div')]
          .find((x) => (x.textContent || '').trim() === '本地图片上传' && x.getBoundingClientRect().width > 10);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      const chooser = await pickFileWithRetry(p, locateLocal, { attempts: 3, timeout: 10000, step: 'zhihu-pin' });
      await chooser.setFiles([file]);

      // 等预览 blob 出现（Modal 上限 18 张；这里只上传 1 张）
      let ready = false, blobN = 0;
      for (let i = 0; i < 15; i++) {
        await sleep(1500);
        const st = await p.evaluate(() => {
          const modal = document.querySelector('.Modal');
          if (!modal) return { blobs: 0, hasInsert: false };
          const seen = new Set();
          for (const im of modal.querySelectorAll('img')) {
            const src = im.currentSrc || im.src || '';
            if (src.startsWith('blob:')) seen.add(src);
          }
          const hasInsert = [...modal.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '插入图片' && b.getBoundingClientRect().width > 0);
          return { blobs: seen.size, hasInsert };
        }).catch(() => null);
        if (!st) continue;
        blobN = st.blobs;
        if (st.blobs >= 1 && st.hasInsert) { ready = true; break; }
      }
      if (!ready) throw new Error('单张图片未在 30s 内进入 Modal 预览');

      // 点选预览：取**最后一个**唯一 blob（Modal 若保留了上轮文件，新传的在末尾）
      const pt = await p.evaluate(() => {
        const modal = document.querySelector('.Modal');
        if (!modal) return null;
        const seen = new Set();
        let last = null;
        for (const im of modal.querySelectorAll('img')) {
          const src = im.currentSrc || im.src || '';
          if (!src.startsWith('blob:') || seen.has(src)) continue;
          seen.add(src);
          last = im;
        }
        if (!last) return null;
        last.scrollIntoView({ block: 'center' });
        const r = last.getBoundingClientRect();
        if (r.width < 10) return null;
        // 取「预览 ∩ 滚动容器可见区」的交集中心，避免点到被裁切掉的区域
        let cont = last.parentElement, cr = null;
        while (cont && cont !== document.body) {
          const s = getComputedStyle(cont);
          if (/auto|scroll/.test(s.overflowY + s.overflowX)) { cr = cont.getBoundingClientRect(); break; }
          cont = cont.parentElement;
        }
        const vr = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
        const box = cr || vr;
        const top = Math.max(box.top, r.top, vr.top), bottom = Math.min(box.bottom, r.bottom, vr.bottom);
        const left = Math.max(box.left, r.left, vr.left), right = Math.min(box.right, r.right, vr.right);
        if (bottom - top < 8 || right - left < 8) return { x: r.x + r.width / 2, y: r.y + r.height / 2, clipped: true };
        return { x: (left + right) / 2, y: (top + bottom) / 2, clipped: false };
      }).catch(() => null);
      if (!pt) throw new Error('Modal 内未找到可点选的预览图');
      await p.mouse.click(pt.x, pt.y);
      await sleep(800);

      const insPos = await p.evaluate(() => {
        const el = [...document.querySelectorAll('.Modal button, .Modal-inner button')]
          .find((b) => (b.textContent || '').trim() === '插入图片' && b.getBoundingClientRect().width > 0);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!insPos) throw new Error('未找到「插入图片」按钮');
      await p.mouse.click(insPos.x, insPos.y);
      await sleep(2500);
      return { blobN };
    };

    let strip = { total: 0, items: [] }, m = { exact: 0, ratio: 0, matched: 0, missing: count };
    for (let i = 0; i < count; i++) {
      let ok = false, before = 0, after = 0;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        const s0 = await readStrip().catch(() => null);
        before = s0 ? s0.total : 0;
        await insertOne(imgs[i]);
        for (let t = 0; t < 10; t++) {
          await sleep(1500);
          const st = await readStrip().catch(() => null);
          if (!st) continue;
          strip = st;
          after = st.total;
          if (after === before + 1) { ok = true; break; }
          if (after > before + 1) break;   // 插多了（Modal 保留了上轮文件）→ 本张作废
        }
        if (!ok) console.log(`  第 ${i + 1} 张插入未生效（图集区计数 ${before} → ${after}），重试`);
      }
      console.log(`  第 ${i + 1}/${count} 张已插入（图集区计数 ${after}）`);
      if (!ok) throw new Error(`第 ${i + 1} 张图片插入失败（图集区计数停在 ${after}），请人工查看页面`);
    }
    strip = await readStrip();
    m = matchStripToSources(strip.items, srcDims);
    console.log(`图片已上稿 ✓（图集区 ${strip.total} 张，与 ${count} 张源图匹配：宽高全等 ${m.exact} / 仅比例一致 ${m.ratio}）`);
    log.step('传图', `图集区 ${strip.total} 张（与源图匹配 ${m.matched}/${count}）`);

  } else {
    console.log('⚠ --manual-images：已跳过自动配图，图集区为空；配图需人工补齐后再点发布');
  }

  // 3) 填正文（Draft.js contenteditable）
  //    坑位⑩（经实测确定，重要）：**必须用 insertText，不能用 keyboard.type**。
  //    逐字 type 时，每次输入「#」都会弹出知乎话题联想面板，平台会把我们打的词
  //    顶替成热榜话题——实测「#英伟达 」变成「#书单推荐」，并在 DOM 里落成
  //    <a class="zed-topic" data-topic-id="1352443">，正文被静默污染。
  //    insertText 一次性插入、不派发按键，联想面板不触发，实测标签原样保留、
  //    \n 也正常成块。
  const ed = await p.$('.public-DraftEditor-content, [contenteditable="true"]');
  if (!ed) throw new Error('未找到想法编辑器（.public-DraftEditor-content）');
  // 用坐标点击（编辑器激活后可能有动画，直接 click 也可，但坐标法更稳）
  const edPos = await p.evaluate(() => {
    const e = document.querySelector('.public-DraftEditor-content, [contenteditable="true"]');
    if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    return { x: r.x + Math.min(r.width / 2, 200), y: r.y + r.height / 2 + 10, w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('编辑器坐标:', JSON.stringify(edPos));
  if (edPos && edPos.w > 0) await p.mouse.click(edPos.x, edPos.y);
  else await ed.click({ timeout: 8000 }).catch(() => {});
  await sleep(600);
  // 2026-10-22（坑位⑫）：正文改用 fillLongText —— insertText 一次性插入 + 回读校验，
  //   对不上自动退回逐块输入。⚠ 逐块输入在 Draft.js 上会触发话题联想（同坑位⑩），
  //   所以「退回」只当保险丝：填完仍走下面的**严格回读校验**，不一致就抛错，
  //   绝不把被平台改写的正文交割出去。
  const readEdLen = () => p.evaluate(() => {
    const e = document.querySelector('.public-DraftEditor-content, [contenteditable="true"]');
    return e ? (e.innerText || '').replace(/\u200b/g, '').trim().length : 0;
  });
  const usedFast = await fillLongText(p, readEdLen, text, { step: 'zhihu-pin' });
  console.log(usedFast ? '正文已填（一次性插入 + 回读校验通过）' : '正文已填（退回逐块输入）');
  log.step('正文', usedFast ? 'insertText 一次性插入（回读通过）' : '退回逐块输入');
  await sleep(1800);
  const state = await p.evaluate(() => {
    const e = document.querySelector('.public-DraftEditor-content, [contenteditable="true"]');
    const full = e ? (e.innerText || '').replace(/\u200b/g, '') : '';
    return { len: full.trim().length, head: full.slice(0, 40), full, tail: full.slice(-120) };
  });
  console.log(`正文已填 ${state.len} 字（首行: ${state.head.replace(/\n/g, ' ')}）`);
  console.log('正文尾部:', JSON.stringify(state.tail));
  // 回读校验：去掉全部空白后，我们给的正文必须原样出现在编辑器里。
  // 少了 = 被平台改写（联想面板顶替 / 截断），必须在这里就炸掉，不能带着脏稿交割。
  const norm = (s) => (s || '').replace(/\u200b/g, '').replace(/\s+/g, '');
  if (!norm(state.full).includes(norm(text))) {
    throw new Error('正文回读不一致：编辑器内容与我们给的正文不匹配（可能被平台改写或截断）。'
      + '\n  期望尾部: ' + JSON.stringify(norm(text).slice(-80))
      + '\n  实际尾部: ' + JSON.stringify(norm(state.full).slice(-80)));
  }
  console.log('正文回读校验 ✓（与给定正文一致，未被平台改写）');
  log.step('正文回读校验', '✓ 与给定正文一致，未被平台改写');

  // 3.5) 收尾复核：填完正文后图集区仍在位（正文输入不该把已传图清掉）
  if (!args['manual-images']) {
    const s2 = await readStrip().catch(() => null);
    if (s2) {
      const m2 = matchStripToSources(s2.items, srcDims);
      console.log(`收尾复核：图集 ${s2.total} 张，与源图匹配 ${m2.matched}/${count}（宽高全等 ${m2.exact}）`);
      if (m2.missing !== 0) throw new Error('填完正文后图集区对不上源图了（可能正文输入清掉了图），请人工确认。');
    }
  }

  // 4) 契约：停「发布」前
  //    坑位⑥（经实测确定）：编辑态下真正的发布按钮文案是「发布」，
  //    「发想法」是未激活态那个 0 宽的占位按钮（w:0）。别按「发想法」找。
  const pub = await p.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '发布' && b.getBoundingClientRect().width > 0);
    return el ? { w: Math.round(el.getBoundingClientRect().width) } : null;
  });
  console.log('「发布」按钮:', pub ? `存在（未点击，w=${pub.w}）` : '未找到');
  if (!pub) log.warn('没找到「发布」按钮（编辑态文案）—— 请人工确认页面状态');
  fs.mkdirSync(cfg.screenshotDir(), { recursive: true });
  const SHOT = shotPath('zhihu-pin.png');
  await shot(p, SHOT, { fullPage: false });
  console.log('screenshot →', SHOT);
  console.log('STATUS: 已停在「发布」前，等待用户人工点击');
  log.step('已停在「发布」前', SHOT);
  log.finish('ok');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e.message);
  // 异常路径也要把日志收尾（耗时表 + 告警汇总），否则失败时反而没有留痕
  if (log) { try { log.finish('failed'); } catch (_) { /* 收尾失败不影响主流程 */ } }
  process.exit(1);
});
