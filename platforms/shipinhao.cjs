// platforms/shipinhao.cjs — 视频号（微信视频号助手）视频发布填单脚本
//
// ── 用途 ────────────────────────────────────────────────────────────
// 把已生成好的视频物料（mp4、短标题、描述 txt、可选 3:4 封面）填进视频号助手后台的
// 发表表单：上传视频 → 填描述 → 填短标题 → 可选自定义封面 → 可选合集 → 可选「不显示位置」
// → 视频标注「含AI生成内容」，最后截图留档并停在「发表」按钮前。
//
// ── 用法（在 publish-kit 目录下执行）─────────────────────────────────
//   node platforms/shipinhao.cjs open
//       只打开视频号壳首页供人工扫码登录，不做任何上传动作。
//       已有壳页则置前、绝不导航（导航可能丢登录态/毁已发表页）；跳 login.html 时提示扫码。
//   node platforms/shipinhao.cjs --video <mp4> --title "<短标题≤16字>" --body-file <描述.txt>
//       [--cover <png>] [--album "<合集名>"] [--location off]
//       一条龙填单。--cover 传自定义封面（3:4 竖版「个人主页和分享卡片」）。
//       不传 --album / --location 时，值取自 config.yaml 的
//       platforms.shipinhao.album 与 platforms.shipinhao.hide_location。
//   node platforms/shipinhao.cjs cover --cover <png>
//       在已填单的 post/create 页上只补封面。
//   node platforms/shipinhao.cjs fix [--title "<新短标题>"] [--album "<合集名>"] [--cover <png>]
//       在已填单的 post/create 页上修补（跳过上传/描述；2026-10-08 新增）——
//       当日实例：短标题含全角冒号被平台判特殊符号、合集推荐条未出落空只告警即交割，均需事后补填。
//       fix 模式豁免交割护栏（只重填指定字段不碰描述；若已发表该页会跳转，URL 校验即拦）。
//
// ── 依赖处理方式 ────────────────────────────────────────────────────
//   1) patchright：走本包 node_modules（require('patchright')），未安装时本脚本直接报错退出，
//      并提示 npm install；不引用包外的任何绝对路径。
//   2) 浏览器：connectOverCDP 连一个已用 --remote-debugging-port 启动的 Chrome，
//      地址取 config.yaml 的 runtime.cdp_url（也可用环境变量 CDP_URL 临时覆盖）。
//      登录态由那个 Chrome profile 负责，本脚本不碰、不创建、不迁移任何浏览器 profile。
//   3) lib/config.cjs：合集名与位置开关的唯一来源。留空 = 跳过该字段 + 控制台告警，
//      脚本永远不猜一个值替你填上（见 lib/config.cjs 顶部的契约说明）。
//   4) 大视频（>48MB）自动走 lib/bigfile-upload.cjs 的 CDP 原生直传，绕开 50MB 传输上限。
//
// ── 契约（最重要的一条）──────────────────────────────────────────────
//   本脚本只做填单，绝不点击「发表」，发布由用户本人完成。
//   另有一条交割护栏：描述已填的表单视为已交割给用户，拒绝重填（确需重填加 --force）。
//
//   本工具不对特定平台做自动化；是否接入某平台由使用者自行判断并承担后果。
//
// ── 流程（视频号助手平台）──────────────────────────────────────────
//   壳首页 → 点「发表视频」（深链 /platform/post/video 不会挂载微应用，必须走壳入口）
//   → 微应用挂载后 input[type=file] 上传 → 视频描述(div.input-editor 逐字输入)
//   → 短标题 → [--cover: 封面编辑弹窗] → 停「发表」前
//
// ── 坑位（实测结论，改选择器前先通读）──────────────────────────────
//   1) wujie 微应用 DOM 渲染在 wujie-app 的 shadowRoot（body 恒空是正常架构，勿误判未挂载）；
//      判断挂载成功的标志是 shadowRoot 内出现 div.input-editor 与 input[type=file]。
//      描述含 # 会触发话题联想，输完点空白处收起。
//   2) 2026-09-21 实测封面：点「编辑」→ 弹窗图片 input 直接 setInputFiles → 「确认」。
//   3) 2026-09-29 加固发表页：/platform/post/create 改版后微应用挂载慢且会重挂，
//      固定等待后 setInputFiles 连续撞 detached——竞态类错误重试 3 轮。
//   4) 2026-10-19 描述回读闭环：描述含 # 会触发话题联想，平台可能把词顶替成热榜话题
//      （知乎同类编辑器已实证）。描述步改为「type → 回读比对 → 不一致就地清空重灌
//      （insertText）→ 再回读」，仍不一致则抛错，**任何情况下都不重传视频**。
//
// ── 2026-10-22 内化（横向能力层接入）新增坑位 ────────────────────────
//   ⑰ **上传区是 Ant Design 拖拽区，`<input type=file>` 是隐藏的**：
//      直接往 input 塞文件**不触发 UI 上传逻辑**（文件不落表单）——老代码 setVideoFile
//      直塞就是这条，所以「视频已提交」其实没提交。
//      正确做法：找 input[type=file] 的**可见祖先**（实测视频是 span.ant-upload.ant-upload-btn，
//      文案「上传时长8小时内…」；封面是 div.single-cover-uploader-wrap，文案「上传封面」），
//      点它 → 浏览器弹**原生 filechooser** → 拦截 → 塞文件。
//      ⚠ wujie 微前端：DOM 在 shadowRoot 里，body 恒空是正常架构 —— 定位要**递归进 shadowRoot**
//        （同 lib/bigfile-upload.cjs 的 DEEP_WALK 写法）。
//      ⚠ 大文件（>48MB）不能走 chooser.setFiles（驱动 50MB 上限）：仍走 lib/bigfile-upload.cjs
//        的 CDP 原生直传（cdpSetFiles 走 shadow 深搜）—— 大文件通道不拆。
//      ⚠ 兜底顺序：**先点可见祖先**（UI 上传逻辑只认这条），唤不起来才退回 setVideoFile。
//   ⑱ **点上传入口后 filechooser 偶发唤不起来**：坐标与成功那轮完全一致，文件选择器
//      就是不弹（微博 / 抖音图文 / 抖音视频三平台都踩过）→ 整条线中止。
//      处置：lib/wait.cjs 的 pickFileWithRetry —— 最多点 3 次，每次**重新取入口坐标**。
//   ⑲ **描述逐字 type 很慢**：逐字 type 每敲一个字符都是一次 CDP 往返，实测 958 字 ≈12s，
//      insertText 一次性插入 ≈0.6s。处置：fillLongText（insertText + 回读校验 + 对不上退回逐块）。
//      ⚠ 描述里的「#」会触发话题联想面板：insertText 不派发按键 → 面板不触发 → 话题词原样保留；
//        但 fillLongText 的兜底逐块输入**会**触发，所以下面仍保留「回读不一致 → 就地清空重灌
//        （insertText）→ 再回读 → 仍不一致就抛错」的原修复路径。
//   ⑳ 体检（preflight）必须在 connectOverCDP **之前**；日志层是**旁路**，只多打不改原输出。
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config.cjs');
const { setVideoFile, cdpSetFiles, LIMIT: BIG_LIMIT } = require('../lib/bigfile-upload.cjs');

let chromium;
try {
  chromium = require('patchright').chromium;
} catch {
  console.error('\n✗ patchright 未安装。在 publish-kit 目录下跑：npm install\n');
  process.exit(1);
}

// 2026-10-22 内化：等待层（长文本一次性插入 / 上传入口重试）+ 日志层 + 起浏览器前体检
const { sleep, fillLongText, pickFileWithRetry } = require('../lib/wait.cjs');
const { create } = require('../lib/log.cjs');
const { preflight } = require('../lib/preflight.cjs');

// 每平台独立日志（旁路）。异常路径也要收尾，否则失败时反而没有留痕。
let log = null;

// 截图统一落 config.yaml 的 publish.screenshot_dir（默认 ./screenshots），目录不存在即建
const SHOT = path.join(cfg.screenshotDir(), 'shipinhao.png');
fs.mkdirSync(path.dirname(SHOT), { recursive: true });

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1], i++;
    else out._.push(argv[i]);
  }
  return out;
}

// 2026-10-08 短标题双硬校验（一条龙 / fix 共用）：
// ①长度 ≤16——input 无 maxlength（侦察实锤 maxLength=-1，前端不拦），超限发表时才被平台拒
//  （2026-10-02 当日 17 字「Anthropic冲刺2万亿IPO」实例）；
// ②符号白名单按平台红字提示口径（2026-10-08 实测原文）：「符号仅支持书名号、引号、冒号、
//  加号、问号、百分号、摄氏度，逗号可用空格替代」——连字符「-」与井号「#」均不支持，
//  「GPT-6」类带连字符词在短标题里必须写作「GPT6」；20 字款发布标题不要直接截作短标题。
const TITLE_ALLOWED = /^[\u4e00-\u9fffA-Za-z0-9\s：《》“”‘’：+？?%℃]+$/;
function checkTitle(t) {
  if ([...t].length > 16) throw new Error('短标题 ' + [...t].length + ' 字超 16 字上限（' + t + '）——请给 ≤16 字短变体（如去「IPO」/压缩写法），不要复用 20 字款');
  if (!TITLE_ALLOWED.test(t)) throw new Error('短标题含平台不支持的特殊符号（' + t + '）——仅允许 中文/字母/数字/空格/书名号/引号/冒号/加号/问号/百分号/摄氏度；连字符（如 GPT-6）须写作 GPT6，逗号用空格替代');
}

// 2026-10-22（坑位⑰）：找 `<input type=file>` 的**可见祖先**（真正的上传入口）。
//   为什么不能直接塞 input：视频号的上传区是 Ant Design 拖拽区，input 是隐藏的，
//   直接塞**不触发 UI 上传逻辑**（文件不落表单）。
//   为什么必须递归 shadowRoot：wujie 微前端的 DOM 在 shadowRoot 里，body 恒空是正常架构
//   （同 lib/bigfile-upload.cjs 的 DEEP_WALK 写法）。
//   可见祖先的判据（从下往上第一个命中）：类名像上传件（ant-upload / uploader）
//   或文案命中提示词；都没有就取**最近的可见祖先**。
//   命中多个候选时先按「可见弹窗优先」（封面编辑弹窗里的上传区才是当前要点的那一个）。
function locateUploadTrigger(p, inputSel, hintRe, acceptRe) {
  return p.evaluate(({ inputSel, hintSrc, acceptSrc }) => {
    const hint = new RegExp(hintSrc);
    const accept = acceptSrc ? new RegExp(acceptSrc) : null;
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // 页面内收集匹配选择器的元素，显式深走 shadowRoot（最多 12 层，同 bigfile-upload）
    const deepQuery = (root, sel, depth) => {
      const out = [];
      if (depth > 12) return out;
      try { for (const el of root.querySelectorAll(sel)) out.push(el); } catch (e) { /* 某些 scope 不支持 */ }
      let all;
      try { all = root.querySelectorAll('*'); } catch (e) { return out; }
      for (const el of all) { if (el.shadowRoot) out.push(...deepQuery(el.shadowRoot, sel, depth + 1)); }
      return out;
    };
    // 查找范围：**可见弹窗优先，然后才是整页**。
    //   ⚠ 不能「有弹窗就只搜弹窗」：发表页上任何时候都可能有别的可见弹窗，
    //     那样会把 shadowRoot 里的视频上传入口整个漏掉（实测踩到过）。
    const dialogs = [...document.querySelectorAll('.weui-desktop-dialog__wrp')].filter(vis);
    const scopes = [...dialogs, document];
    for (const scope of scopes) {
      const inputs = deepQuery(scope, inputSel, 0).filter((el) => !accept || accept.test(el.accept || ''));
      for (const inp of inputs) {
        let node = inp, picked = null;
        for (let i = 0; i < 10 && node; i++) {
          if (vis(node)) {
            const cls = (node.className || '').toString();
            const txt = (node.textContent || '').trim();
            const clsHit = /ant-upload|uploader/.test(cls);
            const txtHit = hint.test(txt) && txt.length < 80;
            if (clsHit || txtHit) { picked = node; break; }
            if (!picked) picked = node;   // 记下最近的可见祖先
          }
          node = node.parentElement;
        }
        if (picked) {
          const r = picked.getBoundingClientRect();
          return {
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            cls: (picked.className || '').toString().slice(0, 60),
            txt: (picked.textContent || '').trim().slice(0, 40),
          };
        }
      }
    }
    return null;
  }, { inputSel, hintSrc: hintRe.source, acceptSrc: acceptRe ? acceptRe.source : '' });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const openOnly = args._[0] === 'open';
  const coverOnly = args._[0] === 'cover';
  const fixMode = args._[0] === 'fix';
  const CDP = process.env.CDP_URL || cfg.cdpUrl();

  // ── 合集 / 位置的取值（去业务默认值：没有默认合集名，也没有默认「不显示位置」）──
  // 规则：
  //   ① 命令行 --album / --location 优先，且对所有模式都生效（保持原有调用方式不变）；
  //   ② 只有「一条龙」模式在没传对应参数时才去读 config.yaml 的 platforms.shipinhao.album /
  //      .hide_location——fix / cover 是「只补指定字段」的修补模式，不让配置项顺手带进来；
  //   ③ 配置为空 → 跳过该字段 + cfg.warnSkipped 告警一次（留空 ≠ 报错退出，也 ≠ 猜值填上）。
  const oneShot = !openOnly && !coverOnly && !fixMode;
  const albumFromCfg = oneShot && !('album' in args);
  const album = ('album' in args ? args.album : (albumFromCfg ? cfg.hint('shipinhao', 'album') : '')) || '';
  const locFromCfg = oneShot && !('location' in args);
  // hide_location 是布尔项：必须走 cfg.bool()，不能用 hint() 也不能直接读 raw 值。
  // hint() 会把 false 变成字符串 'false'（真值），把「关」读成「开」；
  // 直接读 raw 值则遇上用户手写成 "false"（带引号）时同样翻转，且不报任何错。
  const hideLoc = 'location' in args ? args.location === 'off' : (locFromCfg ? cfg.bool('shipinhao', 'hide_location') : false);
  if (oneShot) {
    if (albumFromCfg && !album) cfg.warnSkipped('shipinhao', 'album', '视频号合集');
    if (locFromCfg && !hideLoc) cfg.warnSkipped('shipinhao', 'hide_location', '视频号位置（不显示位置）');
  }

  if (openOnly) {
    // —— open 模式：只把视频号壳首页开出来交给人工登录，不做任何上传动作 ——
    const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
    const ctx = browser.contexts()[0];
    let p0 = ctx.pages().find((x) => /channels\.weixin\.qq\.com/.test(x.url()));
    if (p0) {
      await p0.bringToFront().catch(() => {});
      console.log('视频号页已存在，置前不导航（保护登录态/页面状态）: ' + p0.url().slice(0, 80));
    } else {
      p0 = await ctx.newPage();
      await p0.goto('https://channels.weixin.qq.com/', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(5000);
      console.log('视频号壳首页已打开');
    }
    const url = p0.url();
    if (/login/.test(url)) {
      console.log('⏳ 当前跳在登录页（' + url.slice(0, 80) + '）：请在页面里扫码登录视频号');
      console.log('   登录完成后继续其他平台流程；视频号上传填单按约定放在全平台最后执行');
    } else {
      console.log('✅ 登录态正常（未跳 login），后续无需再扫码；视频号上传填单按约定放在全平台最后执行');
    }
    await p0.screenshot({ path: SHOT }).catch(() => {});
    // 刻意不调 browser.close()。patchright 类型文档对 CDP 连接下的 close() 描述自相矛盾
    // （「Closes the browser and all of its pages」vs「connected to ... disconnects」），
    // 赌错的代价是「用户正在填单的 Chrome 被脚本关掉」。下面就 exit 了，进程退出会自动
    // 断开连接，不依赖这个歧义语义。
    process.exit(0);
  }
  if (coverOnly) {
    if (!args.cover || !fs.existsSync(args.cover)) throw new Error('cover 模式缺 --cover 或文件不存在');
  } else if (fixMode) {
    if (!args.title && !args.album && !args.cover) throw new Error('fix 模式：--title / --album / --cover 至少给一项');
    if (args.title) checkTitle(args.title);
  } else {
    if (!args.video || !fs.existsSync(args.video)) throw new Error('缺 --video 或文件不存在');
    if (!args.title) throw new Error('缺 --title（视频号短标题，≤16 字）');
    checkTitle(args.title);
    if (!args['body-file'] || !fs.existsSync(args['body-file'])) throw new Error('缺 --body-file');
    // 2026-10-03 护栏：一条龙下合集与位置都取自配置（2026-10-03 之前靠命令行参数硬传，
    // 一旦按最小参数跑，直到发布时才发现位置未设「不显示位置」、未加合集）。
    // 两项都没配时在此处明确提示发布前人工处理。
    if (!album || !hideLoc) {
      console.log('警告：本次合集与位置不会自动设置（platforms.shipinhao.album 为空 / hide_location 为 false）——'
        + '发布前需人工处理，或补齐 config.yaml 后停单重跑（node platforms/shipinhao.cjs --video …）');
    }
  }
  const bodyRaw = args['body-file'] ? fs.readFileSync(path.resolve(args['body-file']), 'utf-8').trim() : '';
  // 视频号编辑器逐字输入时连续换行会渲染出空行（2026-09-22 经实测确定）：压成单换行
  const body = bodyRaw.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n');

  // 2026-10-22：每平台独立日志（旁路，只多打不改原有 console 输出）
  log = create({ platform: 'shipinhao', kind: 'video' });

  // 2026-10-22：起浏览器**之前**的体检（坑位⑳）。契约：不过就抛，别 catch 后继续。
  if (oneShot) {
    // 判据：①正文里的 undefined / NaN / [object Object] ②正文长度区间 ③短标题长度
    // 短标题 ≤16 字是**硬约束**（本脚本 checkTitle 已经 throw，这里体检再兜一层）；
    // 描述上限 1000 字（与抖音简介同口径：1000 顶格截断；2026-10-22 ego 通道实测 968 字通过）。
    preflight({
      platform: 'shipinhao',
      title: args.title,
      bodyText: body,
      limits: { titleMax: 16, bodyMax: 1000, bodyMin: 1 },
    });
    log.step('起浏览器前体检', '短标题 ≤16 / 描述 ≤1000 + undefined 守卫');
  } else {
    log.step('起浏览器前体检', (openOnly ? 'open 模式' : (coverOnly ? 'cover 补投模式' : 'fix 修补模式')) + '，无正文，跳过');
  }

  const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
  const ctx = browser.contexts()[0];
  const p0 = ctx.pages().find((x) => /channels\.weixin\.qq\.com/.test(x.url()));
  if ((coverOnly || fixMode) && (!p0 || !/\/platform\/post\/create/.test(p0.url()))) throw new Error('cover/fix 模式：未找到已填单的视频号 post/create 标签页（先跑一条龙）');
  // 交割护栏：发表页已填（疑似已交割给用户）即拒绝，且必须发生在导航前（goto 壳首页即毁单）。
  // fix 模式豁免：只重填 --title/--album/--cover 指定字段、不碰描述；若已发表该页会跳转，
  // 上面 URL 校验即拦（2026-10-08 新增 fix 时一并确定）
  if (p0 && !fixMode && !process.argv.includes('--force')) {
    const guard = await p0.evaluate(() => {
      if (!/\/platform\/post\/create/.test(location.href)) return { filled: false };
      const wj = document.querySelector('wujie-app');
      const box = wj && wj.shadowRoot && wj.shadowRoot.querySelector('.input-editor');
      return { filled: !!(box && box.innerText.trim()) };
    }).catch(() => ({ filled: false }));
    if (guard.filled) throw new Error('[交割护栏] 视频号发表页已填写（疑似已交割给用户），拒绝重复填单。确认需重填：加 --force 重跑，或等用户发表/关闭该页。');
  }
  const p = p0 || await ctx.newPage();

  // 1) 壳首页 → 点「发表视频」让壳启动微应用（深链不挂载）；cover/fix 补投模式整段跳过
  if (!coverOnly && !fixMode) {
  await p.goto('https://channels.weixin.qq.com/platform', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(10000);
  await p.locator('text=发表视频').first().click({ timeout: 10000 });
  await sleep(15000);

  // 2) 上传视频（坑位⑰）：**先点可见祖先**（Ant Design 拖拽区）触发原生 filechooser，
  //    唤不起来才退回 setVideoFile（原行为，含 wujie 重挂载竞态重试）。
  //    file input 在 wujie shadowRoot 内，playwright CSS 穿透 shadow DOM；
  //    2026-09-29 加固：发表页改版为 /platform/post/create 后微应用挂载慢且会重挂，
  //    固定等待后 setInputFiles 连续撞 detached——对竞态类错误重试（重新定位，最多 3 轮）
  {
    const videoFile = path.resolve(args.video);
    const VIDEO_SEL = 'input[type=file][accept*="video"]';
    let upOk = false;
    // ① 首选：点可见祖先 → 原生 filechooser（UI 上传逻辑只认这条路径）
    try {
      const chooser = await pickFileWithRetry(
        p,
        () => locateUploadTrigger(p, VIDEO_SEL, /上传时长|上传视频|点击上传/, /video/),
        { attempts: 3, timeout: 15000, step: 'shipinhao-video' }
      );
      const size = fs.statSync(videoFile).size;
      if (size > BIG_LIMIT) {
        // 大文件：chooser.setFiles 同样受驱动 50MB 上限 → 仍走 CDP 原生直传（大文件通道不拆）
        await cdpSetFiles(p, VIDEO_SEL, 0, videoFile);
        console.log(`视频 ${(size / 1048576).toFixed(1)}MB 超过 50MB 传输上限，已改走 CDP 原生直传（UI 流程已由点击可见祖先触发）: ${path.basename(videoFile)}`);
      } else {
        await chooser.setFiles(videoFile);
        console.log('视频已提交（filechooser 拦截）:', path.basename(videoFile));
      }
      upOk = true;
    } catch (e) {
      console.log('⚠ 点可见祖先未唤起文件选择器（' + e.message + '）→ 退回 setVideoFile');
      log.warn('视频上传：可见祖先路径失败（' + e.message + '）→ 退回 setVideoFile');
    }
    // ② 兜底：setVideoFile（小文件 locator 直塞 / 大文件 CDP 直传）+ 竞态重试
    if (!upOk) {
      for (let round = 1; round <= 3 && !upOk; round++) {
        try {
          await setVideoFile(p, VIDEO_SEL, videoFile);
          upOk = true;
        } catch (e) {
          if (!/detached|Timeout.*exceeded/i.test(e.message || '')) throw e;
          console.log('视频 input 未挂稳（wujie 重挂载竞态），重试 ' + round + '/3');
          await sleep(8000);
        }
      }
      if (!upOk) throw new Error('视频 input 挂稳失败（wujie 微应用重挂载竞态 3 轮未过），请人工上传或稍后重跑');
    }
  }
  console.log('视频已提交，等待上传转码与表单展开…');
  log.step('上传视频', path.basename(args.video));

  // 3) 等描述编辑器出现（挂载完成标志）
  const editor = p.locator('div.input-editor').first();
  await editor.waitFor({ state: 'visible', timeout: 300000 });
  await sleep(2000);

  // 4) 描述：点击聚焦后输入（含 #话题），输完点空白处收起联想
  //    2026-10-19 加固：逐字 keyboard.type 时，描述里的「#」会触发话题联想面板，
  //    平台可能把我们打的词顶替成热榜话题（知乎同类编辑器已实证：「#英伟达」→「#书单推荐」，
  //    10 个标签被污染成 2 个 + 8 个「#自制美食」）。所以这里改成
  //    「先 type、再回读比对；对不上就地清空重灌（insertText 一次性插入，不触发联想）」，
  //    全程不重传视频。回读不一致又不修好就抛错，绝不带脏描述交割。
  const readDesc = () => p.evaluate(() => {
    const wj = document.querySelector('wujie-app');
    const box = wj && wj.shadowRoot ? wj.shadowRoot.querySelector('.input-editor') : null;
    const el = box || document.querySelector('.input-editor');
    return el ? (el.innerText || '').replace(/\u200b/g, '') : '';
  }).catch(() => '');
  const normDesc = (s) => (s || '').replace(/\u200b/g, '').replace(/\s+/g, '');
  await editor.click({ timeout: 8000 });
  await sleep(600);
  // 2026-10-22 内化提速（坑位⑲）：逐字 type → fillLongText
  //   （insertText 一次性插入 + 回读校验 + 对不上自动退回逐块输入）。
  //   ⚠ 描述里的「#」会触发话题联想面板（2026-10-19 实测）：insertText 不派发按键 →
  //     面板不触发 → 话题词原样保留；但 fillLongText 的兜底逐块输入**会**触发面板，
  //     所以下面仍保留「回读不一致 → 就地清空重灌（insertText）→ 再回读 → 仍不一致就抛错」
  //     这条原修复路径（全程不重传视频）。
  const readDescLen = async () => normDesc(await readDesc()).length;
  const usedFast = await fillLongText(p, readDescLen, body, { step: 'shipinhao' });
  console.log(usedFast ? '描述已填（一次性插入 + 回读校验通过）' : '描述已填（退回逐块输入）');
  log.step('描述', usedFast ? 'insertText 一次性插入（回读通过）' : '退回逐块输入');
  await sleep(1200);
  await p.mouse.click(400, 400);
  await sleep(800);
  let descNow = await readDesc();
  if (!normDesc(descNow).includes(normDesc(body))) {
    console.log('⚠ 描述回读与给定正文不一致（疑似话题联想面板把词顶替了）——就地清空重灌，不重传视频');
    await editor.click({ timeout: 8000 });
    await sleep(400);
    await p.keyboard.press('Control+A');
    await sleep(300);
    await p.keyboard.press('Delete');
    await sleep(600);
    await p.keyboard.insertText(body);
    await sleep(1500);
    await p.mouse.click(400, 400);
    await sleep(800);
    descNow = await readDesc();
    console.log('重灌后描述长度:', descNow.length);
  }
  if (!normDesc(descNow).includes(normDesc(body))) {
    throw new Error('描述回读不一致：编辑器内容与给定正文不匹配（期望尾部 ' + JSON.stringify(normDesc(body).slice(-60))
      + '，实际尾部 ' + JSON.stringify(normDesc(descNow).slice(-60)) + '）。请人工检查页面，勿直接发表。');
  }
  console.log('描述回读校验 ✓（与给定正文一致，未被平台改写）');
  log.step('描述回读校验', '✓ 与给定正文一致，未被平台改写');

  } // end !coverOnly&&!fixMode（上传与描述步整体，cover/fix 模式直达后续段）

  // 5) 短标题（一条龙必填；fix 模式给了 --title 时重填，fill 自带清空）
  if (!coverOnly && !fixMode) {
    await p.locator('input[placeholder*="短标题"]').first().fill(args.title);
    console.log('短标题已填（' + [...args.title].length + ' 字）');
    log.step('短标题', args.title + '（' + [...args.title].length + ' 字）');
  } else if (fixMode && args.title) {
    await p.locator('input[placeholder*="短标题"]').first().fill(args.title);
    console.log('短标题已重填（' + [...args.title].length + ' 字）');
  }
  await sleep(500);
  // 5.5) 自定义封面（--cover；3:4 竖版「个人主页和分享卡片」，2026-09-21 实测）
  if (args.cover) {
    const coverFile = path.resolve(args.cover);
    if (!fs.existsSync(coverFile)) throw new Error('--cover 文件不存在: ' + args.cover);
    // 5.5a) hover 封面区让「编辑」浮出，按 .edit-btn 实际坐标点击（locator.click 被 img 拦截）
    const eb = await p.locator('.edit-btn').first().boundingBox();
    if (!eb) throw new Error('封面「编辑」按钮未找到');
    await p.mouse.move(eb.x + eb.width / 2, eb.y - 20);
    await sleep(500);
    await p.mouse.click(eb.x + eb.width / 2, eb.y + eb.height / 2);
    console.log('封面「编辑」已点');
    await sleep(3000);
    // 5.5b) 弹窗「编辑封面」→ 图片 input（accept 含 image）
    //     2026-10-22（坑位⑰）：同视频上传 —— 直接塞 input 不触发 UI 上传逻辑，
    //     改成点 input 的**可见祖先**（实测 div.single-cover-uploader-wrap，文案「上传封面」）
    //     触发原生 filechooser；唤不起来才退回 input 直塞（原行为）。
    let coverSubmitted = false;
    try {
      const chooser = await pickFileWithRetry(
        p,
        () => locateUploadTrigger(p, 'input[type=file][accept*="image"]', /上传封面|上传图片/, /image/),
        { attempts: 3, timeout: 12000, step: 'shipinhao-cover' }
      );
      await chooser.setFiles(coverFile);
      coverSubmitted = true;
    } catch (e) {
      console.log('⚠ 封面可见祖先未唤起文件选择器（' + e.message + '）→ 退回 input 直塞');
      log.warn('封面：可见祖先路径失败（' + e.message + '）→ 退回 input 直塞');
    }
    if (!coverSubmitted) {
      const imgInput = p.locator('input[type=file][accept*="image"]').first();
      await imgInput.waitFor({ state: 'attached', timeout: 15000 });
      await imgInput.setInputFiles(coverFile);
    }
    console.log('自定义封面已提交:', path.basename(coverFile));
    log.step('自定义封面', path.basename(coverFile) + (coverSubmitted ? '（filechooser 拦截）' : '（input 直塞回退）'));
    // 5.5c) 轮询等「确认」出现再点——图片上传期间确认按钮不渲染（2026-09-22 实测约 10s 出现，
    //       固定短等待会误判弹窗已关导致后续合集/位置点击全落遮罩上）
    let okClicked = false;
    for (let i = 0; i < 15 && !okClicked; i++) {
      await sleep(2000);
      const pos = await p.evaluate(() => {
        let found = null;
        const walk = (root) => {
          if (found) return;
          for (const el of root.querySelectorAll('*')) {
            if (found) return;
            if (el.shadowRoot) walk(el.shadowRoot);
            const t = (el.textContent || '').trim();
            if (t === '确认' && (el.className || '').toString().includes('weui-desktop-btn_wrp') && el.getBoundingClientRect().width > 0) {
              const r = el.getBoundingClientRect();
              found = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
        };
        walk(document);
        return found;
      });
      if (pos) {
        await p.mouse.click(pos.x, pos.y);
        okClicked = true;
        console.log('封面「确认」已点（t+' + ((i + 1) * 2) + 's）');
      }
    }
    if (!okClicked) throw new Error('封面弹窗「确认」按钮 30s 未出现，中止（请人工核对封面）');
    await sleep(3000);
    // 5.5d) 验证：弹窗真的关闭（可见的 wrp 消失；不看文本——上传 tab 下标题会变）
    let closed = false;
    for (let i = 0; i < 6 && !closed; i++) {
      await sleep(1500);
      closed = await p.evaluate(() => ![...document.querySelectorAll('*')].some((x) => {
        const cls = (x.className || '').toString();
        if (!cls.includes('weui-desktop-dialog__wrp')) return false;
        const r = x.getBoundingClientRect();
        return r.width > 300 && r.height > 200;
      }));
    }
    console.log(closed ? '封面已用自定义图落表单 ✓（页面应提示「封面已更新」）' : '警告：封面弹窗未关闭，请人工核对截图');
  }

  // 5.6) 合集（优先点「推荐合集：<名> 添加」快捷按钮；album 来自 --album 或 platforms.shipinhao.album）
  if (album) {
    const albumName = album;
    const add = await p.evaluate((name) => {
      let found = null;
      const walk = (root) => {
        if (found) return;
        for (const el of root.querySelectorAll('*')) {
          if (found) return;
          if (el.shadowRoot) { walk(el.shadowRoot); if (found) return; }
          // 快捷添加按钮：所在提示条文本含推荐合集名
          if ((el.className || '').toString().includes('add-btn')) {
            let p2 = el;
            for (let k = 0; k < 4 && p2; k++) {
              p2 = p2.parentElement;
              if (p2 && (p2.textContent || '').includes('推荐合集') && (p2.textContent || '').includes(name)) {
                const r = el.getBoundingClientRect();
                if (r.width > 5) { found = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; return; }
              }
            }
          }
        }
      };
      walk(document);
      return found;
    }, albumName);
    // 2026-09-29 兜底：快捷链接可能不带 add-btn 类（当日实测只剩纯文本「添加」），
    // 类名找不到时按「叶子文本=添加 + 祖先链含 推荐合集+合集名」找
    const add2 = add || await p.evaluate((name) => {
      let found = null;
      const walk = (root) => {
        if (found) return;
        for (const el of root.querySelectorAll('*')) {
          if (found) return;
          if (el.shadowRoot) { walk(el.shadowRoot); if (found) return; }
          if ((el.textContent || '').trim() === '添加' && el.children.length === 0) {
            let p2 = el;
            for (let k = 0; k < 5 && p2; k++) {
              p2 = p2.parentElement;
              if (p2 && (p2.textContent || '').includes('推荐合集') && (p2.textContent || '').includes(name)) {
                const r = el.getBoundingClientRect();
                if (r.width > 5) { found = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; return; }
              }
            }
          }
        }
      };
      walk(document);
      return found;
    }, albumName);
    if (add2) {
      await p.mouse.click(add2.x, add2.y);
      await sleep(2500);
    } else {
      // 2026-10-02 修：推荐条不存在或点击无效时（当日回读仍「选择合集」），不再直接
      // throw，降级走「添加到合集」下拉路径：点 display 展开 → 找合集名 option-item
      // （h<60 排除说明行）→ 点；3 轮不过转人工
      console.log('推荐合集快捷按钮未命中，降级走下拉路径…');
      let picked = false;
      for (let round = 1; round <= 3 && !picked; round++) {
        const disp = await p.evaluate(() => {
          let f = null;
          const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (f) return; if (el.shadowRoot) walk(el.shadowRoot); if (((el.className || '') + '').includes('post-album-display')) { const r = el.getBoundingClientRect(); if (r.width > 10) { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); f = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } } } };
          walk(document);
          return f;
        });
        if (!disp) break;
        await sleep(600);
        const disp2 = await p.evaluate(() => { let f = null; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (f) return; if (el.shadowRoot) walk(el.shadowRoot); if (((el.className || '') + '').includes('post-album-display')) { const r = el.getBoundingClientRect(); if (r.width > 10) f = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } } }; walk(document); return f; });
        await p.mouse.click(disp2.x, disp2.y);
        await sleep(2200);
        const opt = await p.evaluate((name) => {
          let f = null;
          // 2026-10-15 修：平台给合集选项文本追加了内容计数（如「每日新闻共28个内容」），
          // 旧的 `=== name` 精确相等永远匹配不上 → 每期都走到「选项未出现」转人工。
          // 改为 startsWith；option-item 类被 位置/活动 下拉共用，但那些文本不会以合集名开头。
          const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (f) return; if (el.shadowRoot) walk(el.shadowRoot); if (((el.className || '') + '').includes('option-item') && (el.textContent || '').trim().startsWith(name)) { const r = el.getBoundingClientRect(); if (r.width > 10 && r.height < 60) f = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } } };
          walk(document);
          return f;
        }, albumName);
        if (!opt) continue;
        await p.mouse.click(opt.x, opt.y);
        await sleep(2500);
        picked = true;
      }
      if (!picked) console.log('警告：合集下拉路径也未选上（选项未出现）——发布前请手动点「添加到合集」选「' + albumName + '」');
    }
    const albumTxt = await p.evaluate(() => {
      let txt = null;
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
          if ((el.className || '').toString().includes('post-album-display')) txt = (el.textContent || '').trim();
        }
      };
      walk(document);
      return txt;
    });
    console.log(albumTxt && albumTxt.includes(albumName) ? '合集已加: ' + albumTxt + ' ✓' : '警告：合集状态异常（显示：' + albumTxt + '），请人工核对');
    if (albumTxt && albumTxt.includes(albumName)) log.step('合集', albumName + '（回读✓）');
    else log.warn('合集状态异常（显示：' + albumTxt + '）—— 请人工核对');
  } else console.log('合集：本次未设置（未传 --album，且 platforms.shipinhao.album 未配置）——发布前如需合集请手动选择');

  // 5.7) 位置（hide_location 为真 / --location off → 「不显示位置」；2026-09-22 经实测确定）
  // 2026-10-02 修（当日实测点击未生效、回读仍是城市名）：option-item 类名被多个下拉
  // 共用（合集/活动的选项同名），旧逻辑找到即点、点了不验证。修：外层 3 轮「点行展开 →
  // 找『不显示位置』（文本精确 + h<50，地点项 62px 顺带排除）→ 点击 → 回读验证」，
  // 不生效重开下拉再来；3 轮不过转人工
  if (hideLoc) {
    let locSet = false, locDiag = '';
    for (let round = 1; round <= 3 && !locSet; round++) {
      const row = await p.evaluate(() => {
        let found = null;
        const walk = (root) => {
          if (found) return;
          for (const el of root.querySelectorAll('*')) {
            if (found) return;
            if (el.shadowRoot) walk(el.shadowRoot);
            if ((el.className || '').toString().includes('position-display')) {
              const r = el.getBoundingClientRect();
              if (r.width > 10) {
                if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
                found = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
          }
        };
        walk(document);
        return found;
      });
      if (!row) { locDiag = '位置行未找到'; continue; }
      await sleep(800);
      const row2 = await p.evaluate(() => {
        let f = null;
        const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (f) return; if (el.shadowRoot) walk(el.shadowRoot); if (((el.className || '') + '').includes('position-display')) { const r = el.getBoundingClientRect(); if (r.width > 10) f = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } } };
        walk(document);
        return f;
      });
      await p.mouse.click(row2.x, row2.y);
      await sleep(2000);
      const opt = await p.evaluate(() => {
        let found = null;
        const walk = (root) => {
          if (found) return;
          for (const el of root.querySelectorAll('*')) {
            if (found) return;
            if (el.shadowRoot) walk(el.shadowRoot);
            if (((el.className || '') + '').includes('option-item') && (el.textContent || '').trim() === '不显示位置') {
              const r = el.getBoundingClientRect();
              if (r.width > 10 && r.height < 50) found = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
        };
        walk(document);
        return found;
      });
      if (!opt) { locDiag = '下拉未展开或无「不显示位置」项'; continue; }
      await p.mouse.click(opt.x, opt.y);
      await sleep(2500);
      const cur = await p.evaluate(() => {
        let txt = null;
        const walk = (root) => {
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
            if (((el.className || '') + '').includes('position-display')) txt = (el.textContent || '').trim();
          }
        };
        walk(document);
        return txt;
      });
      if (cur === '不显示位置') { locSet = true; console.log('位置已设为不显示 ✓（回读验证）'); log.step('位置', '不显示位置（回读✓）'); }
      else locDiag = '点击未生效（回读: ' + JSON.stringify(cur) + '）';
    }
    if (!locSet) console.log('警告：位置未设为不显示（' + locDiag + '）——发布前请手动点位置行选「不显示位置」');
  }

  // 5.8) 视频标注：默认选「含AI生成内容」（合规必标，2026-09-22 经实测确定）；
  // fix 模式跳过（只修补指定字段，不重复驱动已落好的标注行——2026-10-08）
  //
  // 是否代填受 config.yaml 的 publish.declare_ai 控制（与 B站/知乎/微博保持一致）。
  // 留空/关闭只意味着「脚本不代填」，不代表平台不要求——平台侧仍可能因未标注而拦截。
  if (!fixMode && !cfg.declareAi()) {
    console.warn(
      '⚠  未代填视频标注（config.yaml 的 publish.declare_ai = false）—— 已在发布页留空。\n' +
      '   平台要求 AI 生成内容必须标注，发布前请手动勾选「含AI生成内容」。\n' +
      '   改法：编辑 config.yaml 把 publish.declare_ai 设为 true。'
    );
  }
  if (!fixMode && cfg.declareAi()) {
    // 2026-09-29 修复：页面上有多个 .select-display（位置/链接/活动/视频标注），旧逻辑取第一个
    // 会点错行、下拉里自然没有「含AI生成内容」。改为优先按「选择视频标注」placeholder/文本精确定位
    const row = await p.evaluate(() => {
      const ph = document.querySelector('input[placeholder*="视频标注"]');
      if (ph && ph.offsetParent !== null) {
        const r = ph.getBoundingClientRect();
        if (r.width > 10) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      // 2026-09-29 兜底：标注触发行可能是 select-placeholder（文本=选择视频标注）而非 select-display
      let ph2 = null;
      const walkPh = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (ph2) return;
          if (el.shadowRoot) walkPh(el.shadowRoot);
          if ((el.className || '').toString().includes('select-placeholder') && (el.textContent || '').trim() === '选择视频标注') {
            if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            if (r.width > 10) ph2 = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      };
      walkPh(document);
      if (ph2) return ph2;
      let found = null;
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
          if ((el.className || '').toString().includes('select-display')) {
            const r = el.getBoundingClientRect();
            // 视频标注在表单最底部：取最靠下的一个而非第一个
            if (r.width > 10 && (!found || r.y > found.y)) found = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      };
      walk(document);
      return found;
    });
    if (!row) throw new Error('「选择视频标注」下拉未找到');
    // 2026-09-29 补丁：标注行常在新窗口视口底部之外（1600x1000 下 y≈1174），直接按坐标点会落空。
    // 先把行滚进视口，再重新量坐标（行找器里已对 select-placeholder 行做 scrollIntoView）
    await sleep(800);
    const row2 = await p.evaluate(() => {
      let f = null;
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (f) return;
          if (el.shadowRoot) walk(el.shadowRoot);
          const c = (el.className || '').toString();
          const t = (el.textContent || '').trim();
          if ((c.includes('select-placeholder') && t === '选择视频标注') || c.includes('select-display')) {
            const r = el.getBoundingClientRect();
            if (r.width > 10 && (!f || r.y > f.y)) f = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      };
      walk(document);
      return f;
    });
    if (row2) row.x = row2.x, row.y = row2.y;
    // 下拉渲染有延迟：点开后轮询等选项出现，未出现则再点行重试（最多 3 轮，同位置下拉）
    let opt = null;
    for (let round = 0; round < 3 && !opt; round++) {
      await p.mouse.click(row.x, row.y);
      for (let i = 0; i < 5 && !opt; i++) {
        await sleep(1200);
        opt = await p.evaluate(() => {
          let found = null;
          const walk = (root) => {
            if (found) return;
            for (const el of root.querySelectorAll('*')) {
              if (found) return;
              if (el.shadowRoot) walk(el.shadowRoot);
              if ((el.className || '').toString().includes('mark-tag-option') && (el.textContent || '').trim() === '含AI生成内容') {
                const r = el.getBoundingClientRect();
                if (r.width > 10) found = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
          };
          walk(document);
          return found;
        });
      }
    }
    if (!opt) throw new Error('「含AI生成内容」标注选项未找到（下拉未展开？）');
    // 选项可能在视口底部之外（表单长页），先滚动进视口再按新坐标点击（2026-09-22 实测坑）
    await p.evaluate(() => {
      let el = null;
      const walk = (root) => {
        if (el) return;
        for (const x of root.querySelectorAll('*')) {
          if (el) return;
          if (x.shadowRoot) walk(x.shadowRoot);
          if ((x.className || '').toString().includes('mark-tag-option') && (x.textContent || '').trim() === '含AI生成内容') el = x;
        }
      };
      walk(document);
      if (el) el.scrollIntoView({ block: 'center' });
    });
    await sleep(800);
    const opt2 = await p.evaluate(() => {
      let found = null;
      const walk = (root) => {
        if (found) return;
        for (const el of root.querySelectorAll('*')) {
          if (found) return;
          if (el.shadowRoot) walk(el.shadowRoot);
          if ((el.className || '').toString().includes('mark-tag-option') && (el.textContent || '').trim() === '含AI生成内容') {
            const r = el.getBoundingClientRect();
            if (r.width > 10) found = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      };
      walk(document);
      return found;
    });
    if (!opt2) throw new Error('滚动后「含AI生成内容」选项丢失');
    await p.mouse.click(opt2.x, opt2.y);
    await sleep(2000);
    const done = await p.evaluate(() => {
      let txt = null;
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
          if ((el.className || '').toString().includes('select-display')) txt = (el.textContent || '').trim();
        }
      };
      walk(document);
      return txt;
    });
    console.log(done === '含AI生成内容' ? '视频标注：含AI生成内容 ✓' : '警告：视频标注状态异常（显示：' + done + '），请人工核对');
    if (done === '含AI生成内容') log.step('视频标注', '含AI生成内容（回读✓）');
    else log.warn('视频标注状态异常（显示：' + done + '）—— 请人工核对');
  }

  // 6) 截图，停「发表」前（合集/位置/视频标注等其余表单由人工核对；封面已 --cover 自动化）
  await p.screenshot({ path: SHOT });
  console.log('screenshot →', SHOT);
  console.log('STATUS: 已停在「发表」按钮前，等待用户点击发表');
  log.step('已停在「发表」前', SHOT);
  log.finish('ok');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e.message);
  // 异常路径也要把日志收尾（耗时表 + 告警汇总），否则失败时反而没有留痕
  if (log) { try { log.finish('failed'); } catch (_) { /* 收尾失败不影响主流程 */ } }
  process.exit(1);
});
