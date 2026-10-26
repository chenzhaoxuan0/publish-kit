// platforms/zhihu.cjs — 知乎视频发布填单脚本（patchright + CDP 连接外部 Chrome）
//
// ── 用途 ────────────────────────────────────────────────────────────
// 把已经生成好的视频物料（mp4、标题、描述 txt、封面图）填进知乎创作中心的视频投稿表单：
// 进创作中心 → 发视频 → 传片 → 标题/介绍（含 # 话题）→ 视频标记 → 所属领域 → 封面，
// 最后截图留档并停在「发布视频」按钮前。
//
// ── 用法（在 publish-kit 目录下执行）─────────────────────────────────
//   node platforms/zhihu.cjs --video <mp4> --title "<标题>" --body-file <描述.txt>
//                            [--cover <png>] [--field "<领域>"]
//   node platforms/zhihu.cjs cover --cover <png>
//       封面补投模式：只对已填单的 upload-video 标签页重设封面。
//       （--cover 在一条龙里失败时，等视频转码完再单独重跑这条。）
//   --body-file  正文里的 #词 会逐个走话题联想选中（.topic-name 精确匹配）；
//                话题库里没有精确匹配的，保留为纯文本。
//   --field      所属领域。不传则读 config.yaml 的 platforms.zhihu.field_hint；
//                两者都留空 = 不点领域下拉 + 控制台告警。非必填，失败降级为告警不阻断。
//   --cover      传自定义封面（2026-09-21 实测：知乎建议 3:4 竖封面；
//                「选择视频封面」弹窗 → 本地上传 tab → 中央上传区 filechooser → 确认选择）
//
// ── 依赖处理方式 ────────────────────────────────────────────────────
//   1) patchright：走本包 node_modules（require('patchright')），不引用包外任何绝对路径；
//      未安装时先在 publish-kit 目录跑 npm install。
//   2) 浏览器：connectOverCDP 连一个已用 --remote-debugging-port 启动的 Chrome，
//      地址取 config.yaml 的 runtime.cdp_url（也可用环境变量 CDP_URL 临时覆盖）。
//      登录态由那个 Chrome 的 profile 目录负责（config.yaml 的 runtime.profile_dir），
//      本脚本不碰、不创建、不迁移任何浏览器 profile。
//   3) lib/config.cjs：所属领域与 AI 声明的唯一来源。留空 = 不碰该字段 + 控制台告警，
//      脚本永远不猜一个值替你填上（见 lib/config.cjs 顶部的契约说明）。
//   4) lib/bigfile-upload.cjs：>48MB 的大文件自动改走 CDP 原生直传，绕开驱动 50MB 上限。
//
// ── 契约（最重要的一条）──────────────────────────────────────────────
//   本脚本只做填单，绝不点击「发布」，发布由用户本人完成。
//   另有一条交割护栏：标题已填的表单视为已交割给用户，拒绝重填（确需重填加 --force）。
//
//   本工具不对特定平台做自动化；是否接入某平台由使用者自行判断并承担后果。
//
// ── 流程 ────────────────────────────────────────────────────────────
// creator「开始创作→发视频」→ www.zhihu.com/upload-video 上传 → 标题/介绍
//       → 视频标记「含 AI 生成内容」（按 publish.declare_ai，开启时真实 mouse.click
//       并回读验证）
//       → 所属领域（按 platforms.zhihu.field_hint，点选后回读；未配置则跳过+告警；
//       排在封面之前——封面 FATAL 不得吞掉领域）
//       → [--cover: 封面设置（生效判定=按钮「更改」文本 或 容器 blob 预览图）]
//       → 停「发布视频」前
//
// 固定行为：内容来源不加（2026-09-22 经实测确定：知乎只标注含AI生成内容）。
//
// 五修（2026-10-04 上线稿件复盘：领域缺失/疑缺封面/疑缺声明）：
//   ①领域步原排封面之后，封面 FATAL 把它整体跳过 → 提前到封面之前；
//   ②封面「更改…」按钮文本判定假阴性（封面已生效按钮仍显示 hover 文案「选择视频封面」，
//     编辑页+线上 meta image 双证实）→ 终判加 blob 预览图第二通道；
//   ③声明确认按钮宽松匹配假真 → 点完回读弹窗关闭+标记区叶文本。
//
// ── 坑位（经实测确认）────────────────────────────────────────────────
//   必填下拉须真实鼠标点击（JS click 无效）；正文 # 触发话题联想弹窗，
//   Escape 关不掉，需点击弹窗外区域。以上结论均于 2026-09-16 平台实测确认。
//   2026-09-22 新增坑：upload-video 页会自动恢复上一次未发草稿（实测撞上早间遗留草稿
//   导致脏表单）——填字前强制清空标题与介绍旧值；「选择标记」若已是「含 AI 生成内容」
//   则跳过不再 FATAL；领域步失败只告警。
//
// ── 2026-10-22 内化（横向能力层接入）新增坑位 ────────────────────────
//   ⑥ **点上传入口后 filechooser 偶发唤不起来**：坐标与成功那轮完全一致，文件选择器就是
//     不弹（微博 / 抖音图文 / 抖音视频三平台都踩过）→ 整条线中止。
//     处置：lib/wait.cjs 的 pickFileWithRetry —— 最多点 3 次，每次**重新取入口坐标**
//     （页面重排后旧坐标会落空）；3 次全失败才退回「input 直塞」兜底。
//   ⑦ **介绍正文逐字 type 很慢**：逐字 type 每敲一个字符都是一次 CDP 往返，
//     实测 958 字 ≈12s，insertText 一次性插入 ≈0.6s（省约 11s）。
//     处置：lib/wait.cjs 的 fillLongText（insertText + 回读校验 + 对不上自动退回逐块输入）。
//     ⚠ **话题标签仍必须逐字 type**（见下面话题那圈）：只有 type 才派发按键、触发知乎
//       联想面板，脚本才能在 .topic-name 上精确点选、落地成话题链接。
//     ⚠ 新增**回读校验**：正文必须原样落在编辑器里；对不上 = 联想面板把词顶替了 / 被截断
//       ——宁可炸掉，也不带脏稿交割。
//   ⑧ **体检（preflight）必须在 connectOverCDP 之前**：起完浏览器再查等于白查
//     （「上传后确认成功」只能证明页面上的东西，证明不了喂进去的东西）。
//     另：日志层（lib/log.cjs）是**旁路**，只多打不改原有 console 输出。
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config.cjs');
const { chromium } = require('patchright');
const { setVideoFile } = require('../lib/bigfile-upload.cjs');
// 2026-10-22 内化：等待层（长文本一次性插入 / 上传入口重试）+ 日志层 + 起浏览器前体检
const { sleep, fillLongText, pickFileWithRetry } = require('../lib/wait.cjs');
const { create } = require('../lib/log.cjs');
const { preflight } = require('../lib/preflight.cjs');
// 2026-10-26 内化：截图留档层——截图失败只告警，不参与成败判据
const { shot } = require('../lib/shot.cjs');

// 每平台独立日志（旁路）。异常路径也要收尾，否则失败时反而没有留痕。
let log = null;

// 截图统一落 config.yaml 的 publish.screenshot_dir（不写死在脚本旁边）
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
  const coverOnly = args._[0] === 'cover';
  const CDP = process.env.CDP_URL || cfg.cdpUrl();
  if (coverOnly) {
    if (!args.cover || !fs.existsSync(args.cover)) throw new Error('cover 模式缺 --cover 或文件不存在');
  } else {
    if (!args.video || !fs.existsSync(args.video)) throw new Error('缺 --video 或文件不存在');
    if (!args.title) throw new Error('缺 --title');
    if (!args['body-file'] || !fs.existsSync(args['body-file'])) throw new Error('缺 --body-file');
  }
  // 结尾截图统一落 publish.screenshot_dir（目录不存在即建）
  fs.mkdirSync(cfg.screenshotDir(), { recursive: true });
  const SHOT = shotPath('zhihu.png');
  const body = args['body-file'] ? fs.readFileSync(path.resolve(args['body-file']), 'utf-8').trim() : '';

  // 2026-10-22：每平台独立日志（旁路，只多打不改原有 console 输出）
  log = create({ platform: 'zhihu', kind: 'video' });

  // 2026-10-22：起浏览器**之前**的体检（坑位⑧）。契约：不过就抛，别 catch 后继续。
  if (!coverOnly) {
    // 判据：①正文里的 undefined / NaN / [object Object]（上游生成 bug 外溢到线上内容的经典形态）
    //        ②正文长度区间 ③标题长度
    // ⚠ **不设 titleMax**：知乎视频标题/介绍上限口径**未确认**
    //   （news-publisher 硬约束 #4 原文：「脚本未设防…口径未确认，别依赖」）——
    //   猜一个上限会**误拦合法稿件**（宁可漏拦，不误拦）。要设请先实测确认再回填这里的常量。
    // ⚠ bodySoftMax 2000 是**粗筛**不是平台口径：实测 988 字正常（2026-10-22 ego 通道），
    //   2000 只用来提醒「明显失控」的正文，不承担平台上限的语义。
    //   用**软线**（超了只告警）而不是硬闸 —— 上面这段注释说得很清楚：
    //   「口径未确认，别依赖」「猜一个上限会误拦合法稿件（宁可漏拦，不误拦）」。
    preflight({
      platform: 'zhihu',
      title: args.title,
      bodyText: body,
      limits: { bodySoftMax: 2000, bodyMin: 1 },
    });
    log.step('起浏览器前体检', '正文 undefined 守卫 + 长度区间');
  } else {
    log.step('起浏览器前体检', 'cover 补投模式，无正文，跳过');
  }

  const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
  const ctx = browser.contexts()[0];
  // 优先接管已在 upload-video 的标签页（重跑/残留场景）；「发视频」在新标签页打开时也要能接管
  let p = ctx.pages().find((x) => /zhihu\.com\/upload-video/.test(x.url()));
  if (coverOnly && !p) throw new Error('cover 模式：未找到已打开的 upload-video 标签页（先跑一条龙把视频传上、表单展开）');

  // 1) creator 页 → 开始创作 → 发视频
  if (!p && !coverOnly) {
    // 2026-10-19 修（重要）：原来这里会「接管任意已有的知乎标签页」再 goto /creator。
    // 而 /creator 正是**想法（图文）编辑器**所在页——goto 会把已填好的想法整个冲掉。
    // 2026-10-19 实测事故：先跑 zhihu-pin.cjs 填好知乎想法（图文），再跑本脚本发视频，
    // 结果想法页被导航走，**图文在发布前就没了**，得重传一遍。
    // 现在一律另开新页跑视频：creator 页上已填的想法原样保留。
    const preVideoPages = new Set(ctx.pages().filter((x) => /zhihu\.com\/upload-video/.test(x.url())));
    p = await ctx.newPage();
    await p.goto('https://www.zhihu.com/creator', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(5000);
    await p.evaluate(() => {
      const e = [...document.querySelectorAll('div,button,span')].find((x) => x.textContent.trim() === '开始创作' && x.children.length === 0);
      if (e) e.click();
    });
    await sleep(2500);
    await p.evaluate(() => {
      const e = [...document.querySelectorAll('a,button,div,span,li,p')].find((x) => {
        const t = (x.textContent || '').trim();
        return t === '发视频' || (t.length < 12 && t.includes('发视频') && !t.includes('写'));
      });
      if (e) e.click();
    });
    await sleep(6000);
    if (!/upload-video/.test(p.url())) {
      // 「发视频」通常另开标签页：优先挑**新开**的那个，别抢走已有的 upload-video 页
      const cands = ctx.pages().filter((x) => /zhihu\.com\/upload-video/.test(x.url()));
      const fresh = cands.find((x) => !preVideoPages.has(x));
      p = fresh || cands[cands.length - 1];
      if (!p) throw new Error('未进入 upload-video 页');
    }
  }
  await p.bringToFront();

  // 交割护栏：表单已填（疑似已交割给用户）即拒绝重填（cover 模式不触表单文字，不受限）
  if (!coverOnly && !process.argv.includes('--force')) {
    const already = await p.evaluate(() => {
      const t = document.querySelector('textarea[placeholder="标题"]');
      return !!(t && t.value.trim());
    }).catch(() => false);
    if (already) throw new Error('[交割护栏] 知乎视频表单已填写（疑似已交割给用户），拒绝重复填单。确认需重填：加 --force 重跑，或等用户提交/清空该页。');
  }

  // 2) 上传视频（accept 含 mp4 的 file input，就地展开表单）；cover 模式跳过全部填字步
  if (!coverOnly) {
  await setVideoFile(p, 'input[type=file][accept*="mp4"]', path.resolve(args.video));
  console.log('视频已提交，等待表单展开…');
  log.step('上传视频', path.basename(args.video));
  for (let i = 0; i < 12; i++) {
    await sleep(10000);
    const ok = await p.evaluate(() => !!document.querySelector('textarea[placeholder="标题"]'));
    if (ok) break;
  }
  // 3) 标题（旧草稿清防：upload-video 会自动恢复上次未发草稿，先清后填并复核一次）
  const title = await p.$('textarea[placeholder="标题"]');
  await title.fill('');
  await title.fill(args.title);
  await sleep(1000);
  if ((await title.inputValue().catch(() => '')) !== args.title) {
    await title.fill(args.title);
    console.log('标题二次回填（命中草稿恢复竞态）');
  }
  console.log('标题已填');
  log.step('标题', args.title);
  // 4) 介绍（DraftJS 编辑器）：正文用 insertText 一次性插入（坑位⑦）+ 逐 tag 话题联想选中
  //    知乎话题必须存在于话题库：#词 输入后联想弹窗中点选 .topic-name 精确匹配项才落地为
  //    话题链接；无精确匹配的 tag 保留为纯文本（2026-09-22 起：禁止 Backspace 回删——
  //    会整体吞掉已落地的话题链接并啃正文，实测坑）；失败时点弹窗外收联想、Ctrl+End 回末尾。
  //    光标定位必须 Control+End（End 只到折行行尾，会插进正文中间）。
  const editor = await p.$('.public-DraftEditor-content');
  await editor.click();
  await sleep(500);
  // 旧草稿清防：介绍里可能残留上次草稿正文，全选清空再输入
  await p.keyboard.press('Control+A');
  await p.keyboard.press('Delete');
  await sleep(300);
  const bodyNorm = body.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n');
  const main = bodyNorm.split('\n#')[0];
  const topicTags = (bodyNorm.match(/#[^\s#]+/g) || []).map((x) => x.slice(1));
  // 2026-10-22 内化提速（坑位⑦）：正文主体改用 fillLongText ——
  //   insertText 一次性插入 + 回读校验 + 对不上自动退回逐块输入。
  //   ⚠ 话题标签**仍必须逐字 type**（下面那圈）：只有 type 才派发按键、触发联想面板，
  //     脚本才能在 .topic-name 上精确点选、落地成话题链接。
  const readEditorLen = () => p.evaluate(() => {
    const e = document.querySelector('.public-DraftEditor-content');
    return e ? (e.innerText || e.textContent || '').replace(/\u200b/g, '').trim().length : 0;
  });
  const usedFast = await fillLongText(p, readEditorLen, main, { step: 'zhihu' });
  console.log(usedFast ? '介绍正文已填（一次性插入 + 回读校验通过）' : '介绍正文已填（退回逐块输入）');
  log.step('介绍正文', usedFast ? 'insertText 一次性插入（回读通过）' : '退回逐块输入');
  // 回读校验（坑位⑦的守门）：正文必须原样落在编辑器里。
  //   对不上 = 联想面板把词顶替了 / 被截断 —— 宁可炸掉，也不带脏稿交割。
  const edText = await p.evaluate(() => {
    const e = document.querySelector('.public-DraftEditor-content');
    return e ? (e.innerText || e.textContent || '').replace(/\u200b/g, '') : '';
  });
  const normTxt = (s) => (s || '').replace(/\s+/g, '');
  if (normTxt(edText) && !normTxt(edText).startsWith(normTxt(main))) {
    throw new Error('介绍正文回读不一致（可能被话题联想面板改写或截断）'
      + '\n  期望: ' + JSON.stringify(normTxt(main).slice(0, 80))
      + '\n  实际: ' + JSON.stringify(normTxt(edText).slice(0, 80)));
  }
  await p.keyboard.press('Control+End');
  await sleep(300);
  let linked = 0;
  const droppedTags = [];
  for (const kw of topicTags) {
    await p.keyboard.press('End');
    await sleep(200);
    await p.keyboard.type(' #' + kw, { delay: 100 });
    let hit = null;
    for (let i = 0; i < 6 && !hit; i++) {
      await sleep(1000);
      hit = await p.evaluate((name) => {
        for (const el of document.querySelectorAll('.TopicSuggestion-Popover .Menu-item')) {
          const nm = el.querySelector('.topic-name');
          const r = el.getBoundingClientRect();
          if (nm && nm.textContent.trim() === '#' + name && r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return null;
      }, kw);
    }
    if (hit) {
      await p.mouse.click(hit.x, hit.y);
      await sleep(1200);
      linked++;
    } else {
      // 无精确话题：保留纯文本，点弹窗外收联想，光标回末尾
      await p.mouse.click(300, 500);
      await sleep(600);
      await p.click('.public-DraftEditor-content');
      await sleep(300);
      await p.keyboard.press('Control+End');
      await sleep(200);
      droppedTags.push(kw);
    }
  }
  console.log('话题已选 ' + linked + ' 个' + (droppedTags.length ? '（无精确话题，保留纯文本: ' + droppedTags.join('/') + '）' : ''));
  log.step('话题', linked + '/' + topicTags.length + ' 个落成链接' + (droppedTags.length ? '（未匹配: ' + droppedTags.join('/') + '）' : ''));
  if (droppedTags.length) log.warn('有 ' + droppedTags.length + ' 个话题在联想面板里没有精确匹配，已保留纯文本: ' + droppedTags.join('/'));
  // 6) 视频标记：真实鼠标点击展开 → 选「含 AI 生成内容」→ 确认
  //    是否点选由 config.yaml 的 publish.declare_ai 决定（cfg.declareAi()，默认开）。
  //    关闭时整段跳过、不碰标记控件——平台侧是否强制要求声明由使用者自行判断，
  //    本工具不替他勾；但若稿件确含 AI 生成内容又不声明，平台侧会拦。
  //    旧草稿若已选过「含 AI 生成内容」，展开入口文本不再是「选择标记」——识别后直接跳过
  //    2026-09-29：标记区位于标题/介绍之后的懒渲染区，未滚动就找不到入口——滚动重试 4 轮
  let markBox = null;
  for (let i = 0; i < 4 && !markBox; i++) {
    markBox = await p.evaluate(() => {
      const e = [...document.querySelectorAll('div,span,button')].find((x) => x.textContent.trim() === '选择标记' && x.offsetParent !== null);
      if (!e) return null;
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!markBox) { await p.evaluate(() => window.scrollBy(0, 700)); await sleep(1200); }
  }
  const alreadyMarked = !markBox && await p.evaluate(() =>
    [...document.querySelectorAll('div,span')].some((x) => /含\s*AI\s*生成内容/.test((x.textContent || '').trim()) && x.children.length === 0 && x.offsetParent !== null));
  if (!cfg.declareAi()) {
    console.log('publish.declare_ai = false，跳过视频标记（未碰标记控件；该稿件是否需要声明由你自己确认）');
    log.warn('publish.declare_ai = false，已跳过视频标记 —— 是否需要声明由你自己确认');
  } else if (alreadyMarked) {
    console.log('视频标记：旧草稿已选「含 AI 生成内容」，跳过');
  } else {
  if (!markBox) throw new Error('未找到「选择标记」');
  await p.mouse.click(markBox.x, markBox.y);
  await sleep(2500);
  const optBox = await p.evaluate(() => {
    const e = [...document.querySelectorAll('div,span,li,p')].find((x) => x.textContent.trim() === '含 AI 生成内容' && x.offsetParent !== null);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!optBox) throw new Error('未找到「含 AI 生成内容」选项');
  await p.mouse.click(optBox.x, optBox.y);
  await sleep(1000);
  await p.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '确认' && x.offsetParent !== null);
    if (b) b.click();
  });
  await sleep(1500);
  // 五修（2026-10-04 上线稿件缺声明）：确认按钮宽松匹配曾假真——没点中确认也报成功。
  // 点完回读：弹窗应已关且标记区出现「含 AI 生成内容」可见叶文本；未验证到则明确告警，不静默
  const markOk = await p.evaluate(() => {
    const modalOpen = [...document.querySelectorAll('[class*="Modal"], [class*="modal"], [class*="popover"], [class*="Popover"]')]
      .some((e) => { if (!e || !e.offsetParent) return false; const r = e.getBoundingClientRect(); return r.width > 250 && r.height > 120; });
    if (modalOpen) return false;
    return [...document.querySelectorAll('div,span')].some((x) => /含\s*AI\s*生成内容/.test((x.textContent || '').trim()) && x.children.length === 0 && x.offsetParent !== null);
  });
  if (markOk) {
    console.log('视频标记：含 AI 生成内容（回读验证 ✓）');
    log.step('视频标记', '含 AI 生成内容（回读✓）');
  } else {
    console.log('警告：视频标记回读未确认「含 AI 生成内容」已落表单（弹窗未关或懒渲染）；发布前请人工核对该项，不阻断');
    log.warn('视频标记回读未确认「含 AI 生成内容」已落表单 —— 发布前请人工核对');
  }
  }
  } // end !coverOnly（上传与填字步整体，cover 模式直达封面步）

  // 7) 所属领域（取值优先级：命令行 --field > config.yaml 的 platforms.zhihu.field_hint；
  //    具体可选项以知乎创作中心当下拉拉到的实际列表为准）
  //    五修（2026-10-04 上线稿件缺领域）：原排在封面步之后，封面步 FATAL 会把本步
  //    整体跳过（当时实证）。现提前到封面之前：领域失败仅告警不阻断，但必须执行到；
  //    点选后回读下拉容器文本是否含领域词
  //    注意：下拉选项常在视口外，必须 scrollIntoView 后再取新坐标点击（坐标点击视口外无效）
  //    两处都没配 → 整段跳过、不点下拉 + 告警。不内置任何默认领域：猜错的领域会静默落到
  //    发布页上，用户在发布前不一定会发现；留空的告警是一次明确提醒。
  const field = (args.field || '').trim() || cfg.hint('zhihu', 'field_hint');
  if (!field) {
    cfg.warnSkipped('zhihu', 'field_hint', '知乎所属领域');
    log.warn('所属领域未配置（platforms.zhihu.field_hint 为空）——已跳过，发布前请人工选择');
  } else {
    try {
    const dd = await p.evaluate(() => {
      const items = [...document.querySelectorAll('.VideoUploadForm-item')];
      const el = items.find((d) => /所属领域/.test(d.textContent || ''));
      const box = el && el.querySelector('.VideoUploadForm-selectContainer');
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!dd) throw new Error('「所属领域」下拉未找到');
    await p.mouse.click(dd.x, dd.y);
    await sleep(2000);
    await p.evaluate((name) => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.textContent || '').trim() === name && el.children.length === 0) { el.scrollIntoView({ block: 'center' }); return; }
      }
    }, field);
    await sleep(800);
    const opt = await p.evaluate((name) => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.textContent || '').trim() === name && el.children.length === 0) {
          const r = el.getBoundingClientRect();
          if (r.width > 10) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, field);
    if (!opt) throw new Error('领域选项「' + field + '」未找到');
    await p.mouse.click(opt.x, opt.y);
    await sleep(1500);
    const fieldOk = await p.evaluate((name) => {
      const items = [...document.querySelectorAll('.VideoUploadForm-item')];
      const el = items.find((d) => /所属领域/.test(d.textContent || ''));
      return !!(el && (el.textContent || '').includes(name));
    }, field);
    console.log('所属领域:' + field + (fieldOk ? '（回读验证 ✓）' : '（回读未确认，发布前请人工核对）'));
    log.step('所属领域', field + (fieldOk ? '（回读✓）' : '（回读未确认）'));
    } catch (e) {
      console.log('警告：所属领域未设置（' + e.message + '）；该字段非必填，可人工补选，不阻断');
    }
  }

  // 8) 自定义封面（--cover；知乎建议 3:4 竖封面，用 cover-3x4。
  //    2026-10-05 晚六修，当日实证三坑：①封面按钮可能滚出视口，直接取坐标 mouse.click
  //    点到 y=-77 空处（当日 3 次补投全失败的根因）——必须先 scrollIntoView 再取坐标；
  //    ②封面弹窗已改版：顶层「选择封面 / 本地上传」双 tab，旧 .VideoCoverEditor-Modal
  //    类名选择器全部落空——按全文档文本找「本地上传」tab 物理点击切 tab；
  //    ③「点击上传或将文件拖入此区域」区点击触发 input.click() → 文件选择器——用
  //    playwright filechooser 事件竞态拦截后 setFiles（CDP 层拦截，资源管理器不会弹出；
  //    合成 DragEvent drop 对 React 无效，实测）。上传后弹窗进入「重新上传/确认选择」
  //    状态，物理点「确认选择」收口。
  //    生效判定：主表单封面 img src 以 https://pic*.zhimg.com 开头（服务端回图铁证）
  //    或 blob: 预览，或按钮文本含「更改」；data: base64 帧图不算生效）
  if (args.cover) {
    const coverFile = path.resolve(args.cover);
    if (!fs.existsSync(coverFile)) throw new Error('--cover 文件不存在: ' + coverFile);
    const modalVis = () => p.evaluate(() => [...document.querySelectorAll('[class*="Modal"], [class*="modal"]')]
      .some((e) => e.offsetParent && e.getBoundingClientRect().width > 350));
    // 8a) 滚动入视口 → 打开弹窗
    if (!(await modalVis())) {
      const b = await p.evaluate(() => {
        const el = document.querySelector('.VideoUploadForm-imageEditButton');
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (!b) throw new Error('「更改视频封面」按钮未找到');
      await sleep(800);
      await p.mouse.click(b.x, b.y);
      await sleep(3000);
      if (!(await modalVis())) throw new Error('封面弹窗未打开（按钮坐标 ' + JSON.stringify(b) + '）——检查页面浮层/视口');
    }
    // 8b) 切「本地上传」tab（全文档文本匹配，取可见宽度最大者）
    const tabPos = await p.evaluate(() => {
      const els = [...document.querySelectorAll('div,span,li')]
        .filter((x) => x.offsetParent && (x.textContent || '').trim() === '本地上传');
      if (!els.length) return null;
      const el = els.map((el) => ({ el, r: el.getBoundingClientRect() })).sort((a, b) => b.r.width - a.r.width)[0];
      return { x: Math.round(el.r.x + el.r.width / 2), y: Math.round(el.r.y + el.r.height / 2) };
    });
    if (tabPos) { await p.mouse.click(tabPos.x, tabPos.y); await sleep(2200); }
    else console.log('警告：未找到「本地上传」tab（可能已在 tab 上），继续尝试上传区');
    // 8c) 定位上传区 → filechooser 投图（回退：弹窗内图片 input 直塞）
    //     2026-10-22（坑位⑥）：点上传入口后 filechooser **偶发唤不起来**（坐标与成功那轮
    //     完全一致，就是不弹）→ 整条线中止。处置：pickFileWithRetry 最多点 3 次，
    //     每次**重新取入口坐标**（页面重排后旧坐标会落空）；3 次全失败才退回 input 直塞。
    let zoneSeen = false;
    const locateZone = async () => {
      const z = await p.evaluate(() => {
        const el = [...document.querySelectorAll('div')]
          .filter((x) => x.offsetParent && /点击上传|拖入此区域/.test(x.textContent || '') && x.children.length <= 8).pop();
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (z) zoneSeen = true;
      return z;
    };
    let fc = null;
    try {
      fc = await pickFileWithRetry(p, locateZone, { attempts: 3, timeout: 8000, step: 'zhihu-cover' });
    } catch (e) {
      // 上传区压根不存在 = 弹窗结构改版（原来就是 FATAL，别退化成「静默直塞」）
      if (!zoneSeen) throw new Error('本地上传区未找到（「点击上传/拖入此区域」缺失）——弹窗结构改版，需人工');
      log.warn('封面 filechooser 3 次都没唤起（' + e.message + '）→ 退回 input 直塞');
      fc = null;
    }
    if (fc) {
      await fc.setFiles(coverFile);
      console.log('封面已提交（filechooser 拦截）:', path.basename(coverFile));
    } else {
      const imgInput = await p.$('[class*="Modal"] input[type=file][accept*="image"]') || await p.$('input[type=file][accept*="image"]');
      if (!imgInput) throw new Error('filechooser 未触发且无图片 input 可直塞');
      await imgInput.setInputFiles(coverFile);
      console.log('封面已提交（input 直塞回退）:', path.basename(coverFile));
    }
    // 8d) 等弹窗进入「重新上传/确认选择」状态 → 物理点「确认选择」（最多 16s）
    let confirmed = false;
    for (let i = 0; i < 8 && !confirmed; i++) {
      await sleep(2000);
      const pos = await p.evaluate(() => {
        const mods = [...document.querySelectorAll('[class*="Modal"], [class*="modal"]')]
          .filter((e) => e.offsetParent && e.getBoundingClientRect().width > 350);
        const m = mods[mods.length - 1];
        if (!m) return null;
        const b = [...m.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '确认选择');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (pos) { await p.mouse.click(pos.x, pos.y); confirmed = true; console.log('已点「确认选择」'); }
    }
    if (!confirmed) throw new Error('上传后未出现「确认选择」按钮——图片可能未受理，需人工检查弹窗');
    await sleep(3000);
    // 8e) 生效终判：主表单封面 img src = zhimg CDN 或 blob:（data: base64 帧图不算）
    let ok = false, why = '';
    for (let i = 0; i < 5 && !ok; i++) {
      const probe = await p.evaluate(() => {
        const box = document.querySelector('.VideoUploadForm-item') || document;
        const img = [...box.querySelectorAll('img')].find((i2) => i2.offsetParent);
        const src = (img && img.src) || '';
        const btn = ((document.querySelector('.VideoUploadForm-imageEditButton') || {}).textContent || '').trim();
        return { src, btn };
      });
      if (/^https:\/\/pic\d*\.zhimg\.com/.test(probe.src)) { ok = true; why = '封面 img=zhimg CDN（' + probe.src.slice(0, 44) + '…）'; break; }
      if (/^blob:/.test(probe.src)) { ok = true; why = '封面 img=blob 预览'; break; }
      if (/更改/.test(probe.btn) && probe.src && !/^data:/.test(probe.src)) { ok = true; why = '按钮「' + probe.btn + '」+ img=' + probe.src.slice(0, 30); break; }
      await sleep(2000);
    }
    if (!ok) {
      const failShot = shotPath('zhihu-cover-fail.png');
      await p.screenshot({ path: failShot, timeout: 15000 }).catch(() => {});
      throw new Error('封面未生效（无 zhimg CDN/blob 预览）——已存 ' + failShot + '。处置：重跑 node platforms/zhihu.cjs cover --cover <png>');
    }
    console.log('封面已生效 ✓（' + why + '）');
    log.step('封面', why);
  }

  // 9) 截图，停「发布视频」前
  await shot(p, SHOT);
  console.log('screenshot →', SHOT);
  console.log('STATUS: 已停在「发布视频」按钮前，等待用户点击发布');
  log.step('已停在「发布视频」前', SHOT);
  log.finish('ok');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e.message);
  // 异常路径也要把日志收尾（耗时表 + 告警汇总），否则失败时反而没有留痕
  if (log) { try { log.finish('failed'); } catch (_) { /* 收尾失败不影响主流程 */ } }
  process.exit(1);
});
