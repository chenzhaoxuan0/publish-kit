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
//      不先点「分享此刻的想法…」进编辑态，click 会 30s 超时 invisible。
//   ⑥ 编辑态下真正的发布按钮文案是「发布」，「发想法」是未激活态那个 0 宽的占位按钮（w:0）。
//      别按「发想法」找。
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
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { chromium } = require('patchright');

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

  // 0) 激活想法编辑器（坑位⑤）：.public-DraftEditor-content 常驻 DOM 但
  //    未激活时 getBoundingClientRect() = 0×0，click 会 30s 超时 invisible。
  //    必须先点「分享此刻的想法…」进入编辑态，编辑器才展开有尺寸。
  const activated = await p.evaluate(() => {
    const ed = document.querySelector('.public-DraftEditor-content');
    if (ed && ed.getBoundingClientRect().width > 0) return { alreadyOpen: true };
    for (const el of document.querySelectorAll('div,span,button,a')) {
      const t = (el.textContent || '').trim();
      if (t === '分享此刻的想法...' || t === '分享此刻的想法…' || (t.length > 4 && t.length < 20 && /分享此刻的想法/.test(t))) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 5) return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, t };
      }
    }
    return null;
  });
  if (activated && activated.alreadyOpen) console.log('想法编辑器已处于编辑态');
  else if (activated) {
    console.log('点「分享此刻的想法…」激活编辑器:', JSON.stringify(activated));
    await p.mouse.click(activated.x, activated.y);
    await sleep(2500);
  } else throw new Error('未找到「分享此刻的想法…」入口，编辑器无法激活（页面改版？）');
  // 验证编辑器已展开
  const edOpen = await p.evaluate(() => {
    const ed = document.querySelector('.public-DraftEditor-content');
    const r = ed ? ed.getBoundingClientRect() : { width: 0, height: 0 };
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  console.log('编辑器尺寸:', JSON.stringify(edOpen));
  if (edOpen.w === 0) throw new Error('想法编辑器激活后仍为 0 宽，未能进入编辑态');

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
    const picBtn = await p.evaluate(() => {
      const ed = document.querySelector('.public-DraftEditor-content');
      if (!ed) return null;
      const edBox = ed.getBoundingClientRect();
      const cands = [...document.querySelectorAll('button')].map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width >= 15 && r.width <= 30 && r.height >= 15 && r.height <= 30
          && r.x > edBox.x - 60 && r.x < edBox.x + edBox.width
          && r.y > edBox.y - 5 && r.y < edBox.y + 180);
      if (!cands.length) return null;
      cands.sort((a, b) => a.r.x - b.r.x);
      // 工具栏顺序 # / 表情 / 图片 / 视频 / 图表 —— 图片是第 3 个
      const r = cands[Math.min(2, cands.length - 1)].r;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, n: cands.length };
    });
    if (!picBtn) throw new Error('未找到图片工具栏按钮（icon 定位失败，页面改版？）');
    console.log('L1 图片工具栏按钮:', JSON.stringify(picBtn));
    await p.mouse.click(picBtn.x, picBtn.y);
    await sleep(2500);

    // L2: Popover「上传图片」
    const upPos = await p.evaluate(() => {
      const el = [...document.querySelectorAll('button,div[role=button],a,span,li')]
        .find((x) => (x.textContent || '').trim() === '上传图片' && x.getBoundingClientRect().width > 10);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!upPos) throw new Error('L1 已点开但未找到 Popover「上传图片」（页面改版？）');
    console.log('L2 Popover「上传图片」:', JSON.stringify(upPos));
    await p.mouse.click(upPos.x, upPos.y);
    await sleep(3000);

    // L3: Modal 内「本地图片上传」→ filechooser
    const localPos = await p.evaluate(() => {
      const el = [...document.querySelectorAll('button,div[role=button],a,span,li,div')]
        .find((x) => (x.textContent || '').trim() === '本地图片上传' && x.getBoundingClientRect().width > 10);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!localPos) throw new Error('L2 已点开但未找到 Modal「本地图片上传」（页面改版？）');
    console.log('L3「本地图片上传」:', JSON.stringify(localPos));
    const [chooser] = await Promise.all([
      p.waitForEvent('filechooser', { timeout: 10000 }),
      p.mouse.click(localPos.x, localPos.y),
    ]);
    await chooser.setFiles(imgs);
    console.log(`已通过 filechooser 提交 ${count} 张图（multiple=${chooser.isMultiple()}），等待上传落编辑器…`);

    // 2) 等图片上传进 Modal（正面证据 = Modal 内 blob 预览 ≥count）
    //    然后必须**逐张点选预览图**再点「插入图片」——经实测确定：
    //    不点选直接点「插入图片」会插入平台默认的活动推广图（一张平台自带的运营图），
    //    用户自己的 6 张图被静默丢弃，编辑器里只剩那张活动图。
    let modalOk = false;
    for (let i = 0; i < 20; i++) {
      await sleep(3000);
      const st = await p.evaluate(() => {
        const modal = document.querySelector('.Modal');
        if (!modal) return { modal: false, blobs: 0 };
        // blob: 预览图（每张渲染两层，阈值取一半）
        const blobs = [...modal.querySelectorAll('img')].filter((x) => (x.currentSrc || x.src || '').startsWith('blob:')).length;
        const hasInsert = [...modal.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === '插入图片' && b.getBoundingClientRect().width > 0);
        return { modal: true, blobs, hasInsert };
      }).catch(() => null);
      if (!st) continue;
      console.log(`  t+${(i + 1) * 3}s Modal 预览 blob=${st.blobs} 插入按钮=${st.hasInsert}`);
      if (st.blobs >= count && st.hasInsert) { modalOk = true; break; }
    }
    if (!modalOk) throw new Error(`图片未在 60s 内上传进 Modal 或「插入图片」按钮未出现`);
    console.log('图片已上传进 Modal ✓');

    // 逐张点选预览图（按 blob src 去重；每张先滚进视口再点，8 张时网格会滚动）
    const blobSrcs = await p.evaluate(() => {
      const modal = document.querySelector('.Modal');
      if (!modal) return [];
      const seen = new Set(); const out = [];
      for (const im of modal.querySelectorAll('img')) {
        const src = im.currentSrc || im.src || '';
        if (!src.startsWith('blob:')) continue;
        if (seen.has(src)) continue;
        seen.add(src);
        out.push(src);
      }
      return out;
    });
    const pickN = Math.min(blobSrcs.length, count);
    console.log(`待点选预览 ${pickN} 张（Modal 内 blob 预览共 ${blobSrcs.length} 张）`);
    for (let i = 0; i < pickN; i++) {
      const ok = await p.evaluate((src) => {
        const modal = document.querySelector('.Modal');
        if (!modal) return false;
        const im = [...modal.querySelectorAll('img')].find((x) => (x.currentSrc || x.src || '') === src);
        if (!im) return false;
        im.scrollIntoView({ block: 'center' });
        return true;
      }, blobSrcs[i]).catch(() => false);
      if (!ok) continue;
      await sleep(200);
      const pt = await p.evaluate((src) => {
        const modal = document.querySelector('.Modal');
        if (!modal) return null;
        const im = [...modal.querySelectorAll('img')].find((x) => (x.currentSrc || x.src || '') === src);
        if (!im) return null;
        const r = im.getBoundingClientRect();
        if (r.width < 10) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, blobSrcs[i]).catch(() => null);
      if (!pt) continue;
      await p.mouse.click(pt.x, pt.y);
      await sleep(350);
    }
    await sleep(1200);
    console.log('预览图已逐张点选');

    // 点「插入图片」→ 图落进**图集区**（不是编辑器容器，见坑位⑦）
    const insPos = await p.evaluate(() => {
      const el = [...document.querySelectorAll('.Modal button, .Modal-inner button')]
        .find((b) => (b.textContent || '').trim() === '插入图片' && b.getBoundingClientRect().width > 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!insPos) throw new Error('未找到「插入图片」按钮');
    console.log('点「插入图片」:', JSON.stringify(insPos));
    await p.mouse.click(insPos.x, insPos.y);
    await sleep(3000);

    // 3) 等图片真正落进**图集区**
    //    坑位⑦：图不在 Draft.js 编辑器容器里，在编辑器上方的 div.DraggableTags。
    //    旧判据数编辑器容器 → 恒 0 → 误判「没传上去」（10-19 期据此误降级成人工补图）。
    //    坑位⑧：还要逐张对上源图宽高，防止「平台默认活动图顶替了我的图」。
    let imgOk = false, strip = { total: 0, items: [] }, m = { exact: 0, ratio: 0, matched: 0, missing: count };
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      const st = await readStrip().catch(() => null);
      if (!st) continue;
      strip = st;
      m = matchStripToSources(strip.items, srcDims);
      console.log(`  t+${(i + 1) * 2}s 图集=${strip.total} 张，与源图匹配=${m.matched}/${count}（宽高全等 ${m.exact} / 仅比例一致 ${m.ratio}）`);
      if (m.missing === 0 && m.matched >= count) { imgOk = true; break; }
    }
    if (!imgOk) {
      throw new Error(`图片未落图集区：检出 ${strip.total} 张，与源图匹配 ${m.matched}/${count}（缺 ${m.missing}）。`
        + '请人工查看页面确认（下方截图已留档）。');
    }
    console.log(`图片已上稿 ✓（图集区 ${strip.total} 张，与 ${count} 张源图匹配：宽高全等 ${m.exact} / 仅比例一致 ${m.ratio}）`);
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
  await p.keyboard.insertText(text);
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
  fs.mkdirSync(cfg.screenshotDir(), { recursive: true });
  const SHOT = shotPath('zhihu-pin.png');
  await p.screenshot({ path: SHOT, fullPage: false });
  console.log('screenshot →', SHOT);
  console.log('STATUS: 已停在「发布」前，等待用户人工点击');
  process.exit(0);
})();
