// weibo-image.cjs — 微博九宫格图文发布（填单脚本）
//
// 用途：把一批已生成好的图片 + 正文填进微博首页的发布器，停在「发送」按钮前。
//   终点由用户人工点击，本脚本一步也不越界。
//
// 用法：
//   node platforms/weibo-image.cjs --media <dir> --title "标题" --body-file <简介.txt>
//                                 [--count 6] [--force]
//   --media      图片目录，按 img-01.png 起连续命名
//   --title      并入正文首行（微博无独立标题框）
//   --body-file  纯文本正文文件
//   --count      实际张数（默认 6）
//   --force      跳过「交割护栏」。护栏检测到页面上已有文字就中止，是为了不污染真实发布页。
//
// 流程：https://weibo.com/ 首页 composer → 点「图片」工具按钮拦截原生 filechooser 传多图
//   → 等九宫格缩略图落表单 → 填正文 → 填内容声明 → 停「发送」前
//
// 依赖：
//   - 浏览器通道用 patchright，经 CDP 连一个已经登录好的浏览器。CDP 地址取自
//     config.yaml 的 runtime.cdp_url；环境变量 CDP_URL 可临时覆盖。
//     依赖装不上或浏览器没起时，看 bin/login.cjs 与 bin/doctor.cjs。
//   - 「内容由AI生成」声明由 config.yaml 的 publish.declare_ai 统一控制（默认开），
//     本脚本不提供命令行开关——声明是合规项，不该藏在一次性的运行参数里。
//   - 结尾截图落到 config.yaml 的 publish.screenshot_dir 目录。
//
// 契约：只做填单，绝不点击「发送」。
//
// 本工具不对特定平台做自动化；是否接入某平台由使用者自行判断并承担后果。
//
// 坑位（经实测确定）：
//   ① 页面有 5 个 textContent==='图片' 的元素（含外层容器），必须按 getBoundingClientRect()
//      面积取最小那个，point 到外层会点空。
//   ② 必须走「点按钮 + filechooser」路径；直塞隐藏 input 不触发 UI 上传逻辑，图不落表单。
//   ③ 遗留微博标签页有草稿恢复机制，reload 后旧文复活混入新填（同工具集的微博视频脚本
//      同样踩过）——与视频脚本一致：关掉遗留标签、开新页。
//   ④ 内容声明是独立必填项，不选会被拦；AI 生成的图卡应当声明，选项文案见坑位⑥。
//   ⑤ 交割护栏：全量 textarea/contenteditable 检测 >10 字即视为已交割/遗留草稿。
//   ⑥ 内容声明的触发器是 span.woo-pop-ctrl（文本恰为「内容声明」），页面上同名元素有 6 个
//      （外层容器 + 工具栏 wrapper），必须限定在 .wbpro-form 内取；
//      选项文案是「内容由AI生成」（不是「含AI生成内容」），面板展开后取面积最小且在视口内的那个。
//
//   ── 2026-10-22 接入横向能力层（lib/wait.cjs / lib/log.cjs / lib/preflight.cjs）──
//   ⑦ 点「图片」入口**偶发唤不起文件选择器**（坐标与成功那轮完全一致；微博 / 抖音图文 /
//      抖音视频三个平台都踩过）→ 统一走 pickFileWithRetry：最多 3 次，每次**重新定位
//      入口并重取坐标**（页面重排后旧坐标会落空）。
//   ⑧ 起浏览器前先体检（preflight）：正文里的 undefined/NaN/[object Object]（上游生成
//      bug 外溢到线上内容）、正文长度上限、以及**图集实际张数 vs --count**。
//      体检不过就抛错中止，**不起浏览器**（宁可不发，也不发错）。
//      ⚠ 图集张数这条**没有**用 preflight({mediaDir, declaredCount}) 直接判：
//      lib/preflight.cjs 的 listImages 只索引「数字开头」的文件名（/^(\d+)/），
//      而微博九宫格的约定是 img-01.png → 直接交进去 byName 恒为空、每次都判
//      「图集不足」→ 体检永远不通过。这里改用 listImages 数实际张数自己比。
//   ⑨ 正文填充：微博九宫格正文是**纯 textarea**，本脚本用 ta.fill()（一次性赋值，
//      不派发按键）——它已经是「一次性插入」，不比 insertText 慢，且**不会**触发联想面板
//      的前缀替换。所以这里**不需要** fillLongText（那个是给逐字 type 的场景用的）。
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config.cjs');
const { chromium } = require('patchright');
// 横向能力层：等待/日志/体检三件事统一走 lib/，平台脚本不再各写各的 sleep 与轮询
const { sleep, waitFor, pickFileWithRetry } = require('../lib/wait.cjs');
const { create } = require('../lib/log.cjs');
const { preflight, listImages } = require('../lib/preflight.cjs');

// 运行日志器（**旁路**：只多打印，不改变任何既有 console.log 的行为与时机）。
// 放模块作用域是为了让末尾的 .catch() 也能收尾（异常路径要写 failed）。
let log = null;

/** 告警：控制台 + 日志器（两处都写，异常路径日志器可能还没建） */
function warn(msg) {
  console.warn('⚠ ' + msg);
  if (log) log.warn(msg);
}

// 截图统一落 config.yaml 的 screenshot_dir（不写死在脚本旁边，也不留在这个仓库里）
const shotPath = (name) => path.join(cfg.screenshotDir(), name);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1], i++;
    else out._.push(argv[i]);
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.media) throw new Error('缺 --media <dir>');
  if (!args['body-file'] || !fs.existsSync(args['body-file'])) throw new Error('缺 --body-file');
  const body = fs.readFileSync(path.resolve(args['body-file']), 'utf-8').trim();
  const text = args.title ? `${args.title}\n${body}` : body;
  const count = parseInt(args.count || '6', 10);
  const media = path.resolve(args.media);
  const imgs = Array.from({ length: count }, (_, i) => path.join(media, `img-${String(i + 1).padStart(2, '0')}.png`));
  imgs.forEach((f) => { if (!fs.existsSync(f)) throw new Error('图片缺失: ' + f); });
  // 物料守卫：正文出现 undefined/NaN 即 FATAL（曾经有上游生成脚本的 bug 把「undefined。」
  // 一路推进真实发布页，返工要删稿重发，这个洞不值得再踩一次）
  if (/undefined|NaN|\[object Object\]/.test(text)) throw new Error('[物料守卫] 正文含 undefined/NaN，先修文件再发');

  // 运行日志器（旁路）。放在参数校验之后：参数就不对的调用不该留下日志文件。
  log = create({ platform: 'weibo', kind: 'image' });
  log.step('参数校验', count + ' 张 / ' + path.basename(media));

  // ── 起浏览器前体检（2026-10-22 加，坑位⑧）──────────────────────────
  // 契约：体检不过 → 抛错中止，**不 catch**（宁可不发，也不发错）。
  // 判据：
  //   ① 图集实际张数 vs --count（见坑位⑧：这条自己比，不能直接交给 preflight 的
  //      mediaDir/declaredCount —— 它的 listImages 只认「数字开头」的文件名）
  //   ② 正文含 undefined / NaN / [object Object]（preflight 自带这条检查）
  //   ③ 正文 ≤ 2000 字（微博正文上限；微博九宫格无独立标题框，--title 并入正文首行，
  //      所以标题长度没有单独口径，跟着正文一起算）
  // 图集张数只数本脚本真会传的 img-NN.png（目录里的其它图片不参与，免得误报）。
  const mediaFiles = listImages(media).files.filter((f) => /^img-\d+\.png$/i.test(f));
  if (mediaFiles.length < count) {
    throw new Error(
      `[preflight:weibo] 图集不足：--count 说传 ${count} 张，${media} 里只有 ${mediaFiles.length} 张 img-NN.png —— 体检不过就不起浏览器。`
    );
  }
  if (mediaFiles.length > count) {
    // 「目录里比声称的多」= 可能少发了图：2026-10-20 那次事故就是投递单只列了 1 张、
    // 各平台判据「渲染张数 ≥ count」恒成立、结果发了残缺图集。这里大声报出来。
    const msg = `${media} 里有 ${mediaFiles.length} 张 img-NN.png，本次只传 ${count} 张（--count）——确认这就是要发的张数`;
    console.warn('⚠ [preflight:weibo] ' + msg);
    log.warn(msg);
  }
  preflight({
    platform: 'weibo',
    bodyText: text,
    // ⚠ 不设 titleMax：微博九宫格**没有独立标题框**（--title 并入正文首行），
    //   标题没有单独的字数口径，跟着正文一起算（跟知乎想法 V2 的 maxLength=-1 同理）。
    // ⚠ bodyMax 用**软线**：微博正文的平台硬上限在本仓库没有实测记录
    //   （仓库既有口径是 900 字信噪比软线）。硬闸必须有实测依据，否则口径一改就误拦。
    limits: { bodySoftMax: 2000, bodyMin: 1 },
  });

  const browser = await chromium.connectOverCDP(process.env.CDP_URL || cfg.cdpUrl(), { timeout: 15000 });
  const ctx = browser.contexts()[0];

  // 交割护栏 + 全新页策略（与微博视频脚本沿用同一套 lessons）
  if (!process.argv.includes('--force')) {
    for (const t of ctx.pages().filter((x) => /weibo\.com/.test(x.url()) && !/passport/.test(x.url()))) {
      const filled = await t.evaluate(() => [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .map((e) => ((e.value || e.textContent || '')).trim()).filter((s) => s.length > 10)
        .map((s) => s.slice(0, 30))).catch(() => []);
      if (filled.length) throw new Error('[交割护栏] 微博页已有文字（疑似已交割或遗留草稿）:' + JSON.stringify(filled) + '。请人工关闭该标签页后重跑；确认可弃加 --force。');
    }
  }
  for (const t of ctx.pages().filter((x) => /weibo\.com/.test(x.url()) && !/passport/.test(x.url()))) await t.close().catch(() => {});
  const p = await ctx.newPage();
  await p.goto('https://weibo.com/', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(8000);
  if (/passport\.weibo|signin|newlogin/.test(p.url())) throw new Error('微博未登录: ' + p.url());
  console.log('微博首页已开:', p.url());
  log.step('开页', p.url());

  // 1) 点「图片」按钮 → 拦截 filechooser 传多图（坑位②：不能直塞隐藏 input）
  // ⚠️ 2026-10-22 内化（坑位⑧）：**上传区没初始化完就点「图片」，会出现只进去 1 张**。
  //    → 点之前先等 composer（.wbpro-form）真的挂上并有可见尺寸。
  //      条件等待，不用固定 sleep。
  const composerReady = await waitFor(
    async () =>
      p.evaluate(() => {
        const f = document.querySelector('.wbpro-form');
        if (!f) return null;
        const r = f.getBoundingClientRect();
        return r.width > 100 && r.height > 50 ? true : null;
      }).catch(() => null),
    { timeout: 15000, interval: 500, step: 'weibo-image' }
  ).catch(() => null);
  if (!composerReady) {
    warn('composer（.wbpro-form）在 15s 内没就绪 —— 继续点「图片」，但若最终只进去 1 张，是这里的原因');
    log.warn('composer 未就绪就点了上传入口');
  } else {
    log.step('composer 就绪', '.wbpro-form 已挂载');
  }

  //    坑位⑦：入口偶发点了不弹文件选择器 → pickFileWithRetry 最多 3 次，
  //    每次都**重新定位入口并重取坐标**（页面重排后旧坐标会落空）。
  let btnInfo = null;
  const locateImageBtn = async () => {
    const b = await p.evaluate(() => {
      const cands = [...document.querySelectorAll('button,div,span,a,i,label')].filter((el) => {
        const t = (el.textContent || '').trim();
        const r = el.getBoundingClientRect();
        return t === '图片' && r.width > 5 && r.width < 200;   // 坑位①：排除大容器
      });
      if (!cands.length) return null;
      cands.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.width * ra.height - rb.width * rb.height; });
      const r = cands[0].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: cands[0].tagName, cls: String(cands[0].className).slice(0, 50) };
    });
    if (b) {
      log.step('定位上传入口', JSON.stringify(b));
      if (!btnInfo) { btnInfo = b; console.log('「图片」按钮:', JSON.stringify(b)); }
    }
    return b;
  };
  let chooser = null;
  try {
    chooser = await pickFileWithRetry(p, locateImageBtn, { attempts: 3, timeout: 15000, step: 'weibo-image' });
  } catch (e) {
    throw new Error('「图片」入口 3 次点击都没唤起文件选择器（' + e.message + '）——平台可能改版，或入口被遮挡。请人工核对页面后重试。');
  }
  await chooser.setFiles(imgs);
  console.log(`已通过 filechooser 提交 ${count} 张图（multiple=${chooser.isMultiple()}），等待九宫格渲染…`);
  log.step('上传图片', count + ' 张（multiple=' + chooser.isMultiple() + '）');

  // 2) 等九宫格缩略图落表单
  //    ⚠️ 2026-10-22 内化（判据从 v1 改到 v4，实测依据见 ego 通道的同款坑位注释）：
  //      v1「页面上小尺寸缩略图数」→ **太松**。微博首页几十个图标都算进去，
  //         「6 张只进 1 张」也判成成功（2026-10-20 用户实查：整轮只传了 1 张图却报成功）。
  //      v2「同行 80~120px 方图取最大组」→ 微博九宫格是**多行**排布
  //         （实测第一行 3 张 y=426、第二行 3 张 y=532），只取一行 → 误报 3 张。
  //      v3「98×98 且 src 含 bmiddle」→ 有效，但**统计范围是全页**，
  //         首页里别的 98×98 方图会混进来 → 仍是假成功的口子。
  //      v4（现在）→ **限定在 composer（.wbpro-form）内**数；找不到 composer 容器
  //         才退回全页范围并**在日志里标明用了哪个范围**。
  //         —— 宁可漏判（报错让人看）不可假成功。
  let gridOk = false;
  let gridState = null;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const st = await p.evaluate(() => {
      const cands = [...document.querySelectorAll('img')].filter((x) => {
        const src = x.currentSrc || x.src || '';
        if (!src.includes('bmiddle')) return false;
        const r = x.getBoundingClientRect();
        return r.width >= 90 && r.width <= 106 && r.height >= 90 && r.height <= 106;
      });
      const form = document.querySelector('.wbpro-form');
      const inForm = form ? cands.filter((x) => form.contains(x)) : [];
      return {
        page: cands.length,
        scoped: inForm.length,
        used: inForm.length > 0 ? inForm.length : cands.length,
        scope: form ? 'composer(.wbpro-form)' : '全页(找不到 composer 容器)',
      };
    }).catch(() => null);
    if (!st) continue;
    gridState = st;
    console.log(`  t+${(i + 1) * 3}s 全页=${st.page} composer内=${st.scoped} 采用=${st.used}（范围=${st.scope}）`);
    if (st.used >= count) { gridOk = true; break; }
  }
  if (!gridOk) {
    throw new Error(
      `九宫格没上全：只认出 ${gridState ? gridState.used : 0}/${count} 张` +
        `（判据=98×98 且 src 含 bmiddle，范围=${gridState ? gridState.scope : '?'}）。请人工核对页面。`
    );
  }
  console.log(`九宫格已渲染 ✓ ${JSON.stringify(gridState)}`);
  log.step('九宫格渲染', `${gridState.used}/${count} 张（范围=${gridState.scope}）`);

  // 3) 填正文（微博无独立标题框，标题并入首行）
  const ta = await p.$('textarea[placeholder*="新鲜事"], textarea._input_1rz8r_8') || await p.$('textarea');
  if (!ta) throw new Error('未找到正文 textarea');
  await ta.click();
  await sleep(400);
  // 逐行输入触发联想（微博正文 #话题走联想），但先纯文本填入
  await ta.fill(text);
  await sleep(1500);
  const filledLen = await ta.inputValue();
  console.log(`正文已填 ${filledLen.length} 字`);
  log.step('填正文', filledLen.length + ' 字（fill 一次性赋值）');

  // 4) 内容声明（必填）选「内容由AI生成」
  //    坑位⑥（经实测确定）：触发器是 span.woo-pop-ctrl（文本恰为「内容声明」），
  //    页面上同名元素有 6 个（外层容器 + 工具栏 wrapper），必须限定在 .wbpro-form 内取。
  //    选项文案是「内容由AI生成」（不是抖音那套「内容由AI生成」弹窗 / 不是「含AI生成内容」），
  //    面板展开后取面积最小且在视口内的那个。
  //    开关来自配置 publish.declare_ai（默认开）——留空不选会被平台拦，所以这里默认开而不是默认猜。
  // --no-declare 是单次覆盖。迁移时它一度被整体删掉，导致原本靠这个 flag 临时不声明的
  // 调用方「不报错、声明照填」——静默的行为反转比直接报错更难查。单次用 flag，全局用配置。
  const wantDeclare = cfg.declareAi() && !args['no-declare'];
  if (wantDeclare) {
    await p.evaluate(() => { const t = document.querySelector('textarea'); if (t) t.scrollIntoView({ block: 'center' }); });
    await sleep(800);
    const trig = await p.evaluate(() => {
      const form = document.querySelector('.wbpro-form') || document;
      const el = form.querySelector('span.woo-pop-ctrl');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.y < 0 || r.y > window.innerHeight) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (trig) {
      await p.mouse.click(trig.x, trig.y);
      await sleep(2200);
      const opt = await p.evaluate(() => {
        const cands = [...document.querySelectorAll('div,li,span,a,label')]
          .filter((el) => (el.textContent || '').trim() === '内容由AI生成')
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 10 && r.height > 5 && r.y > 0 && r.y < window.innerHeight);
        if (!cands.length) return null;
        cands.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
        const { r } = cands[0];
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (opt) { await p.mouse.click(opt.x, opt.y); await sleep(2200); console.log('内容声明已选「内容由AI生成」✓'); log.step('内容声明', '内容由AI生成'); }
      else { console.log('未找到「内容由AI生成」选项（面板可能改版），请人工核对'); log.warn('未找到「内容由AI生成」选项（面板可能改版），请人工核对'); }
    } else { console.log('未找到内容声明触发器（span.woo-pop-ctrl），请人工核对'); log.warn('未找到内容声明触发器（span.woo-pop-ctrl），请人工核对'); }
  } else {
    console.log('publish.declare_ai = false，跳过内容声明（如实图内容请保持这样；AI 图卡会被平台拦）');
    log.warn('publish.declare_ai = false，已跳过内容声明（AI 图卡会被平台拦）');
  }

  // 5) 契约：停「发送」前
  const sendBtn = await p.evaluate(() => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '发送' && b.getBoundingClientRect().width > 0);
    return el ? { y: Math.round(el.getBoundingClientRect().y) } : null;
  });
  console.log('「发送」按钮:', sendBtn ? '存在（未点击）' : '未找到');
  fs.mkdirSync(cfg.screenshotDir(), { recursive: true });
  const SHOT = shotPath('weibo-image.png');
  await p.screenshot({ path: SHOT, fullPage: false });
  console.log('screenshot →', SHOT);
  console.log('STATUS: 已停在「发送」前，等待用户人工点击');
  log.step('收尾', '停在「发送」前');
  log.finish('ok');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e.message);
  if (process.env.WB_DEBUG_STACK) console.error(e.stack);
  if (log) { log.warn('FATAL ' + e.message); log.finish('failed'); }
  process.exit(1);
});
