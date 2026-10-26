// platforms/bilibili.cjs — B站视频投稿填单脚本（patchright + CDP 连接外部 Chrome）
//
// ── 用途 ────────────────────────────────────────────────────────────
// 把已经生成好的视频物料（mp4、标题、简介 txt、标签、封面图）填进 B站创作中心的投稿表单：
// 传视频 → 关通知弹窗 → 填标题/简介/标签 → 设分区 → 创作声明 → 设封面，
// 最后截图留档并停在「提交投稿」按钮前。
//
// ── 用法（在 publish-kit 目录下执行）─────────────────────────────────
//   node platforms/bilibili.cjs --video <mp4> --title "<标题>" --body-file <简介.txt>
//                              [--tags "AI,大模型"] [--tags-file <bili-tags.txt>]
//                              [--cover <png>] [--cover-16x9 <png>]
//   node platforms/bilibili.cjs cover --cover <png> [--cover-16x9 <png>]
//       封面补投模式：只对已填单的投稿页标签页重设封面。
//       （--cover 在一条龙里失败时，等视频转码完再单独重跑这条。）
//   --cover       4:3 主图（首页推荐封面槽）
//   --cover-16x9  16:9 图（个人空间封面槽）
//
// ── 依赖处理方式 ────────────────────────────────────────────────────
//   1) patchright：走本包 node_modules（require('patchright')），不引用包外任何绝对路径；
//      未安装时先在 publish-kit 目录跑 npm install。
//   2) 浏览器：connectOverCDP 连一个已用 --remote-debugging-port 启动的 Chrome，
//      地址取 config.yaml 的 runtime.cdp_url（也可用环境变量 CDP_URL 临时覆盖）。
//      登录态由那个 Chrome 的 profile 目录负责（config.yaml 的 runtime.profile_dir），
//      本脚本不碰、不创建、不迁移任何浏览器 profile。
//   3) lib/config.cjs：分区与 AI 声明的唯一来源。留空 = 不碰该字段 + 控制台告警，
//      脚本永远不猜一个值替你填上（见 lib/config.cjs 顶部的契约说明）。
//   4) lib/bigfile-upload.cjs：>48MB 的大文件自动改走 CDP 原生直传，绕开驱动 50MB 上限。
//
// ── 契约（最重要的一条）──────────────────────────────────────────────
//   本脚本只做填单，绝不点击「提交投稿」，发布由用户本人完成。
//   另有一条交割护栏：标题已填的表单视为已交割给用户，拒绝重填（确需重填加 --force）。
//
//   本工具不对特定平台做自动化；是否接入某平台由使用者自行判断并承担后果。
//
// ── 流程 ────────────────────────────────────────────────────────────
// member.bilibili.com 投稿页 input 上传 → 等表单展开 → 关通知弹窗 →
//       标题/简介/标签（回车创建）→ 分区（按 platforms.bilibili.category_hint；
//       未配置则不点下拉、保留系统推荐并告警）→ 创作声明（按 publish.declare_ai；
//       开启时选「含AI生成内容」，真实 mouse.click）→
//       封面：自定义图（点封面设置区→弹窗「上传封面/添加封面」filechooser 或直塞图片
//       input→裁剪「确定」→「完成」）或推荐帧 → 停「提交投稿」前
//
// ── 标签（2026-10-05 七修起，经实测确定）─────────────────────────────
//   B站改版为「输入后回车直接创建」——清预填杂词 + type 验证 + Enter 创建 + 严格 chips 回读；
//   不传标签来源直接报错，杜绝静默默认标签。
//
// ── 封面双比例分传（2026-10-07，经实测确定）─────────────────────────
//   弹窗内 4:3 与 16:9 是两个独立槽位，各传各图，禁用「双比例同步改动」
//   （脚本每槽上传前主动检测并取消勾选）；调用方（workflow）两参都传。
//
// ── 坑位（经实测确认）────────────────────────────────────────────────
//   上传完成会弹「通知权限」对话框遮挡表单，先点「知道了」；声明 bcc-select 与
//   封面弹窗「完成」（div.button submit，非 button 标签）都必须真实鼠标点击或
//   任意元素文本匹配定位。以上结论均于 2026-09-16 平台实测确认。
//   2026-09-22 加固：封面入口文案兼容「上传封面/添加封面」（当日实测改版）；封面区
//   随视频转码延迟渲染，入口最多轮询 120s；filechooser 超时回退直塞弹窗内图片 input。
//
// ── 2026-10-22 内化（横向能力层接入）新增坑位 ────────────────────────
//   ⑬ **通知权限弹窗是浏览器级的，会硬停整个脚本**：B站上传完成会弹「是否允许通知」
//      的浏览器对话框（不是页面里的 DOM），脚本等不到页面 → 直接超时中止。
//      处置：在**上传之前**用 Playwright 的 context.grantPermissions(['notifications'],
//      { origin: 'https://member.bilibili.com' }) 预授权，让那个框根本不弹。
//      ⚠ 这是**授权通知权限**的合规浏览器 API 调用，不是绕过登录、不碰 profile、不清 cookie。
//      ⚠ 放在上传**之前**而不是「上传完成、等待表单之前」：上传期间就可能弹框。
//   ⑭ **点上传入口后 filechooser 偶发唤不起来**：坐标与成功那轮完全一致，文件选择器
//      就是不弹（微博 / 抖音图文 / 抖音视频三平台都踩过）→ 整条线中止。
//      处置：lib/wait.cjs 的 pickFileWithRetry —— 最多点 3 次，每次**重新取入口坐标**；
//      3 次全失败才退回「弹窗内图片 input 直塞」（原兜底语义保留）。
//   ⑮ **简介逐字 type 很慢**：逐字 type 每敲一个字符都是一次 CDP 往返，
//      实测 958 字 ≈12s，insertText 一次性插入 ≈0.6s。处置：fillLongText
//      （insertText + 回读校验 + 对不上自动退回逐块输入）。
//   ⑯ 体检（preflight）必须在 connectOverCDP **之前**；日志层是**旁路**，只多打不改原输出。
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
  const SHOT = shotPath('bilibili.png');
  // 简介归一化：CRLF→LF + 压多换行（B站编辑器空行问题，同视频号）；简介只取正文（tag 走独立标签栏）
  const body = args['body-file'] ? fs.readFileSync(path.resolve(args['body-file']), 'utf-8').trim()
    .replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n').split('\n#')[0] : '';
  // 2026-10-01 标签来源重构：旧版内置了一组默认标签，在调用方漏传 --tags 时会被静默使用，
  // 连续多期线上稿件的标签因此固定成同一组词（上线后实测发现）。现取消一切默认标签——缺来源
  // 直接报错；并支持 --tags-file 读调用方产出的标签文件（空白分隔）；
  // 标签写入策略改为「页面推荐 tags 优先、标签文件补齐去重」（见标签步）。
  let tags = (args.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (args['tags-file']) {
    const ftags = fs.readFileSync(path.resolve(args['tags-file']), 'utf-8').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    const seen = new Set(tags);
    for (const t of ftags) if (!seen.has(t)) { tags.push(t); seen.add(t); }
  }
  if (!tags.length && !coverOnly) throw new Error('缺标签来源：传 --tags "a,b" 或 --tags-file bili-tags.txt（不再设默认标签，避免静默落错标签）');

  // 2026-10-22：每平台独立日志（旁路，只多打不改原有 console 输出）
  log = create({ platform: 'bilibili', kind: 'video' });

  // 2026-10-22：起浏览器**之前**的体检（坑位⑯）。契约：不过就抛，别 catch 后继续。
  if (!coverOnly) {
    // 判据：①正文里的 undefined / NaN / [object Object]（上游生成 bug 外溢到线上内容的经典形态）
    //        ②正文长度区间 ③标题长度
    // 标题/简介上限（B站投稿页实测口径，2026-10-22 ego 通道回显「标题 12/80 + 简介 900/2000」）：
    //   titleMax 80 字 / bodyMax 2000 字。超了平台会拒，体检直接拦下。
    preflight({
      platform: 'bilibili',
      title: args.title,
      bodyText: body,
      limits: { titleMax: 80, bodyMax: 2000, bodyMin: 1 },
    });
    log.step('起浏览器前体检', '标题 ≤80 / 简介 ≤2000 + undefined 守卫');
  } else {
    log.step('起浏览器前体检', 'cover 补投模式，无正文，跳过');
  }

  const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
  const ctx = browser.contexts()[0];
  let p = ctx.pages().find((x) => /member\.bilibili\.com/.test(x.url()));
  if (coverOnly && !p) throw new Error('cover 模式：未找到已打开的 member.bilibili.com 标签页（先跑一条龙把视频传上）');
  // 交割护栏：稿件标题已填（疑似已交割给用户）即拒绝，且必须发生在导航前（导航即毁单）；cover 模式不受限
  if (!coverOnly && p && !process.argv.includes('--force')) {
    const filled = await p.evaluate(() => {
      const t = document.querySelector('input[placeholder="请输入稿件标题"]');
      return !!(t && t.value.trim());
    }).catch(() => false);
    if (filled) throw new Error('[交割护栏] B站投稿表单已填写（疑似已交割给用户），拒绝重复填单。确认需重填：加 --force 重跑，或等用户提交/清空该页。');
  }
  if (!coverOnly) {
  if (!p) p = await ctx.newPage();
  await p.goto('https://member.bilibili.com/platform/upload/video/frame', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(8000);
  if (/passport\.bilibili\.com/.test(p.url())) throw new Error('B站未登录: ' + p.url());

  // 2026-10-22（坑位⑬）：**先预授权浏览器通知权限**，再上传。
  //   B站上传完成会弹**浏览器级**通知权限对话框（不在页面 DOM 里，脚本点不掉）→
  //   等不到页面 → 整条脚本硬停超时。预授权后那个框根本不弹。
  //   ⚠ 合规的浏览器 API 调用：只是**授权通知**，不碰 profile、不清 cookie、不绕登录。
  //   ⚠ 放在上传**之前**（不只是「等待表单之前」）：上传期间就可能弹框。
  try {
    const context = (p.context && typeof p.context === 'function') ? p.context() : ctx;
    if (context && typeof context.grantPermissions === 'function') {
      await context.grantPermissions(['notifications'], { origin: 'https://member.bilibili.com' });
      console.log('已预授权浏览器通知权限（避免上传完成后的通知权限弹窗硬停）');
      log.step('预授权通知权限', 'origin=https://member.bilibili.com');
    } else {
      console.log('提示：拿不到 BrowserContext，通知权限未预授权（上传后若弹权限框需人工点「允许」）');
      log.warn('拿不到 BrowserContext，通知权限未预授权');
    }
  } catch (e) {
    console.log('通知权限预授权未生效（' + e.message + '）——不影响主流程');
    log.warn('通知权限预授权未生效：' + e.message);
  }

  // 1) 上传视频（第一个 video accept input）
  await setVideoFile(p, 'input[type=file][accept*="mp4"]', path.resolve(args.video));
  console.log('视频已提交，等待表单展开…');
  log.step('上传视频', path.basename(args.video));
  for (let i = 0; i < 15; i++) {
    await sleep(10000);
    const st = await p.evaluate(() => {
      const t = document.body.textContent.replace(/\s+/g, ' ');
      return {
        titleInput: !!document.querySelector('input[placeholder="请输入稿件标题"]'),
        uploading: /上传中|转码中|剩余/.test(t),
      };
    });
    if (st.titleInput && !st.uploading) break;
  }
  // 2) 关闭「通知权限」弹窗（遮挡表单）
  await p.evaluate(() => {
    const d = document.querySelector('.videoup-notification-dialog');
    if (!d) return;
    const b = [...d.querySelectorAll('button, .bcc-btn')].find((x) => /知道了|我知道|关闭/.test(x.textContent));
    if (b) { b.click(); return; }
    const c = d.querySelector('[class*="close"]');
    if (c) c.click();
  });
  await sleep(1500);
  // 3) 标题
  const title = await p.$('input[placeholder="请输入稿件标题"]');
  await title.fill(args.title);
  console.log('标题已填');
  log.step('标题', args.title);
  // 4) 简介（contenteditable 富文本，Quill）
  //    2026-10-22 内化提速（坑位⑮）：逐字 type → fillLongText
  //    （insertText 一次性插入 + 回读校验 + 对不上自动退回逐块输入）
  const ed = await p.$('.ql-editor, [contenteditable="true"]');
  if (ed) {
    await ed.click();
    await sleep(500);
    const readIntroLen = () => p.evaluate(() => {
      const e = document.querySelector('.ql-editor, [contenteditable="true"]');
      return e ? (e.innerText || e.textContent || '').trim().length : 0;
    });
    const usedFast = await fillLongText(p, readIntroLen, body, { step: 'bilibili' });
    console.log(usedFast ? '简介已填（一次性插入 + 回读校验通过）' : '简介已填（退回逐块输入）');
    log.step('简介', usedFast ? 'insertText 一次性插入（回读通过）' : '退回逐块输入');
  } else {
    console.log('警告：简介编辑器未找到');
    log.warn('简介编辑器未找到，简介未填');
  }
  // 5) 标签（2026-10-05 七修，当日实证两坑）：①B站投稿页已改版为「输入后回车直接创建」
  //    ——原联想弹窗整个移除，旧「点精确联想项」逻辑永远找不到候选而全部跳过（当日 10 词
  //    全军覆没的根因）；②页面会默认预填「学习/练习」等推荐杂词 chip，占满 10 个名额。
  //    新流程：先清预填杂词（物理点 chip 的 svg.close）→ 逐词 type 验证输入值 → Enter
  //    创建 → 严格回读 .label-item-v2-container chips 验证，失败重试一次。
  //    推荐垫底逻辑废除（10-02 教训：推荐词挤占每日词名额，且新页面推荐词会预填）。
  const readChips = () => p.evaluate(() =>
    [...document.querySelectorAll('#tag-container .label-item-v2-container')]
      .map((c) => ((c.querySelector('.label-item-v2-content') || {}).textContent || '').trim())
      .filter(Boolean));
  // 5a) 清除预填杂词（不属于目标 tags 的 chip）
  const removeForeign = async () => {
    for (let round = 0; round < 3; round++) {
      const targets = await p.evaluate((tags) => {
        const out = [];
        for (const chip of [...document.querySelectorAll('#tag-container .label-item-v2-container')]) {
          const t = ((chip.querySelector('.label-item-v2-content') || {}).textContent || '').trim();
          if (!tags.includes(t)) {
            const svg = chip.querySelector('svg.close');
            if (svg) { const r = svg.getBoundingClientRect(); out.push({ t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); }
          }
        }
        return out;
      }, tags);
      if (!targets.length) return;
      for (const c of targets) { await p.mouse.click(c.x, c.y); await sleep(700); console.log('已删除预填杂词 chip: ' + c.t); }
    }
  };
  await removeForeign();
  // 5b) 逐词 type + Enter 创建，严格回读验证（失败重试一次）
  const tagInput = await p.$('input[placeholder*="标签"]');
  if (tagInput) {
    const missing = [];
    for (const t of tags) {
      let ok = false;
      for (let i = 0; i < 2 && !ok; i++) {
        if ((await readChips()).includes(t)) { ok = true; break; }
        await tagInput.click();
        await tagInput.fill('');
        await tagInput.type(t, { delay: 120 });
        await sleep(450);
        const val = await p.evaluate(() => { const i2 = [...document.querySelectorAll('input')].find((x) => /标签/.test(x.placeholder || '')); return i2 ? i2.value : null; });
        if (val !== t) { console.log('标签「' + t + '」输入值异常: ' + val); continue; }
        await p.keyboard.press('Enter');
        await sleep(750);
        ok = (await readChips()).includes(t);
      }
      console.log((ok ? '✓ ' : '✗ ') + t);
      if (!ok) missing.push(t);
    }
    const selected = await readChips();
    console.log('已选标签回读(' + selected.length + '):', selected.join(','));
    console.log(missing.length
      ? '警告：每日标签有词未落上: ' + missing.join(',') + ' —— 发布前请人工补'
      : (selected.length === tags.length ? '每日标签全部落上 ✓（' + selected.length + '/' + tags.length + '）' : '每日标签全部落上 ✓（含 ' + (selected.length - tags.length) + ' 个复用词）'));
    if (missing.length) log.warn('有 ' + missing.length + ' 个标签没落上: ' + missing.join(',') + ' —— 发布前请人工补');
    else log.step('标签', selected.length + ' 个已落上');
  } else {
    console.log('警告：标签输入框未找到，本单无标签，发布前请人工补');
  }
  // 5.5) 分区（2026-10-02 新增，经实测确定）：系统推荐不可靠——同一内容类型实测会给出
  //      不同的推荐分区，故改为按 config.yaml 的 platforms.bilibili.category_hint 显式
  //      指定，不依赖推荐值。DOM 侦察实测：分区面板由 .video-human-type .select-controller
  //      点击展开，目标分区是面板里的一级分区叶子（item-cont-main，与其他一级分区平级）；
  //      点后回读 .select-item-cont 文本验证。
  //      未配置 category_hint → 整段跳过、不点下拉，保留系统推荐并告警转人工（不阻断）
  const category = cfg.hint('bilibili', 'category_hint');
  if (!category) {
    cfg.warnSkipped('bilibili', 'category_hint', 'B站分区');
  } else {
  try {
    let zoneOk = false;
    for (let round = 1; round <= 3 && !zoneOk; round++) {
      const zc = await p.evaluate(() => {
        const c = document.querySelector('.video-human-type .select-controller');
        if (!c) return null;
        c.scrollIntoView({ block: 'center' });
        const r = c.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!zc) { await sleep(2000); continue; }
      await p.mouse.click(zc.x, zc.y);
      await sleep(1800);
      const opt = await p.evaluate((name) => {
        const e = [...document.querySelectorAll('*')].find((x) => x.offsetParent !== null && x.childElementCount === 0 && (x.textContent || '').trim() === name && /item-cont-main/.test((x.className || '').toString()));
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, category);
      if (!opt) { console.log('分区面板未出现「' + category + '」项（第 ' + round + ' 轮），重试…'); continue; }
      await p.mouse.click(opt.x, opt.y);
      await sleep(1500);
      const cur = await p.evaluate(() => { const e = document.querySelector('.video-human-type .select-item-cont'); return e ? (e.textContent || '').trim() : null; });
      if (cur === category) { zoneOk = true; console.log('分区：' + category + '（回读 ✓）'); }
      else console.log('分区点击未生效（回读: ' + JSON.stringify(cur) + '），重试…');
    }
    if (!zoneOk) console.log('警告：分区未设为「' + category + '」（保留系统推荐），发布前请人工改选');
    if (zoneOk) log.step('分区', category + '（回读✓）');
    else log.warn('分区未设为「' + category + '」（保留系统推荐）—— 发布前请人工改选');
  } catch (e) {
    console.log('警告：分区设置失败（' + String(e.message || e).slice(0, 100) + '）——保留系统推荐，发布前请人工改选「' + category + '」');
  }
  }
  // 6) 创作声明：真实鼠标点击展开 → 「含AI生成内容」
  //    是否点选由 config.yaml 的 publish.declare_ai 决定（cfg.declareAi()，默认开）。
  //    关闭时整段跳过、不碰声明控件——平台侧是否强制要求声明由使用者自行判断，
  //    本工具不替他勾；但若稿件确含 AI 生成内容又不声明，平台侧会拦。
  // 2026-09-29 二次修正（状态感知）：声明下拉有时在主表单可见（最大化窗口），有时收进「更多设置」
  // 折叠区——先直接找 select 并试点选项，找不到才切折叠区。不再无条件点「更多设置」：
  // 最大化下折叠区常已展开，无条件点击会把它点收，声明反而消失（当日实测 FATAL）
  const findDeclSel = () => p.evaluate(() => {
    // 2026-09-30 修：声明行真实容器为 .statement-main，其内 .bcc-select 即声明下拉；
    // 旧「找最近 bcc-select」逻辑会被页头可见的「创作声明」悬浮提示实例带偏（命中 y≈31 页首，
    // 点击落空 → 下拉未展开 → 选项找不到）。优先 statement-main 精确定位 + scrollIntoView
    // 拉到视口中央（顶部固定导航会遮挡 y<60 区域的点击），fallback 老逻辑。
    const stmt = document.querySelector('.statement-main .bcc-select');
    if (stmt && stmt.offsetParent !== null) {
      stmt.scrollIntoView({ block: 'center' });
      const r = stmt.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    const e = [...document.querySelectorAll('input')].find((x) => x.placeholder && x.placeholder.includes('创作声明') && x.offsetParent !== null);
    if (e) { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    const lab = [...document.querySelectorAll('*')].find((el) => el.childElementCount === 0 && el.textContent.trim() === '创作声明' && el.offsetParent !== null && el.closest('.statement-main'));
    if (!lab) return null;
    const lr = lab.getBoundingClientRect();
    let best = null, bestD = Infinity;
    for (const s of document.querySelectorAll('[class*="bcc-select"]')) {
      if (s.offsetParent === null) continue;
      const r = s.getBoundingClientRect();
      const d = Math.abs((r.y + r.height / 2) - (lr.y + lr.height / 2));
      if (d < bestD && r.width > 50) { bestD = d; best = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }
    }
    return bestD < 120 ? best : null;
  });
  if (cfg.declareAi()) {
  let declared = false;
  // 2026-10-02 三修（DOM 侦察实测）：下拉面板里同文本元素有两个——
  // ARTICLE.vu-hover-tips（悬停气泡，不可交互）与 LI.bcc-option（真选项）。旧
  // find('li.bcc-option, li, ...') 命中气泡 → 点击无效 → declared=true 假阳性
  // （当日创作声明实际为空）。修：① 选项只认 li.bcc-option 且文本精确等于；
  // ② 每次点击后回读 .statement-main input.bcc-select-input-inner 的 value
  // （未选=空，选中=「含AI生成内容」），不满足重开下拉重试；③ 开启声明时 3 轮不过
  // 直接 FATAL，不再假真放行
  for (const toggle of [false, true, false]) {
    if (declared) break;
    if (toggle) {
      await p.evaluate(() => {
        const e = [...document.querySelectorAll('*')].find((x) => x.childElementCount === 0 && x.textContent.trim() === '更多设置' && x.offsetParent !== null);
        if (e) e.click();
      });
      await sleep(1200);
    }
    const sel = await findDeclSel();
    if (!sel) continue;
    await p.mouse.click(sel.x, sel.y);
    for (let i = 0; i < 5 && !declared; i++) {
      await sleep(1200);
      const opt = await p.evaluate(() => {
        const e = [...document.querySelectorAll('li.bcc-option')].find((x) => x.offsetParent !== null && (x.textContent || '').trim() === '含AI生成内容');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!opt) continue;
      await p.mouse.click(opt.x, opt.y);
      await sleep(1200);
      const val = await p.evaluate(() => { const inp = document.querySelector('.statement-main input.bcc-select-input-inner'); return inp ? (inp.value || '').trim() : null; });
      if (val && /AI/.test(val)) declared = true;
      else console.log('声明点击未生效（回读: ' + JSON.stringify(val) + '），重开下拉重试…');
    }
  }
  if (!declared) throw new Error('创作声明未写上（li.bcc-option 精确点击 + 回读 3 轮未过，已开启声明时必填项不放行）——发布前请人工选「含AI生成内容」');
  await sleep(800);
  console.log('创作声明：含AI生成内容（回读验证 ✓）');
  } else {
    console.log('publish.declare_ai = false，跳过创作声明（未碰声明控件；该稿件是否需要声明由你自己确认）');
  }
  } // end !coverOnly（上传与填字步整体，cover 模式直达封面步）
  // 7) 封面（必填）：--cover 走自定义封面（封面制作弹窗），否则点系统推荐帧
  //    2026-10-07 经实测确定：B站封面**双比例分传**——「首页推荐封面（4:3）」与「个人空间封面
  //    （16:9）」两个独立槽位各传各的图，禁用「双比例同步改动」（勾选=一张图同改两槽）。
  //    --cover=4:3 主图；--cover-16x9 可选传 16:9 槽（workflow 调用方两参都传）。
  //    弹窗结构 2026-10-07 dbg 探查实测：.cover-editor-panel-canvas 下两槽
  //    div(.active/.inactive)，槽 title 文本「首页推荐封面（4:3）」/「个人空间封面（16:9）」，
  //    同步 checkbox 在 label.sync-checkbox.bcc-checkbox；上传入口 .bcc-upload.cover-upload
  //    （filechooser，超时回退直塞 input[accept="image/png, image/jpeg"]）。
  const coverFile = args.cover ? path.resolve(args.cover) : null;
  const cover16File = args['cover-16x9'] ? path.resolve(args['cover-16x9']) : null;
  if (args.cover && !fs.existsSync(coverFile)) throw new Error('--cover 文件不存在: ' + args.cover);
  if (args['cover-16x9'] && !fs.existsSync(cover16File)) throw new Error('--cover-16x9 文件不存在: ' + cover16File);
  if (coverFile) {
    // 封面制作弹窗打开（已被上一次上传顺带关闭时重开）。封面区随视频转码延迟渲染（2026-09-22 实测），
    //     入口文案兼容「上传封面/添加封面」双版本，最多轮询 120s
    const openDialog = async () => {
      const already = await p.evaluate(() => !![...document.querySelectorAll('.bcc-dialog')]
        .find((x) => /封面制作/.test(x.textContent || '') && x.getBoundingClientRect().width > 0));
      if (already) return;
      let area = null;
      for (let i = 0; i < 24 && !area; i++) {
        area = await p.evaluate(() => {
          const el = document.querySelector('.cover-main')
            || [...document.querySelectorAll('div,button,span,a')].find((d) => /封面设置|添加封面|上传封面/.test((d.textContent || '').trim()) && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().width < 300);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + Math.min(r.width / 2, 120), y: r.y + r.height / 2 };
        });
        if (!area) { if (i === 0) console.log('封面入口未渲染，等待视频处理（最多 120s）…'); await sleep(5000); }
      }
      if (!area) throw new Error('封面设置区域 120s 内未出现（视频仍在处理？稍后用 cover 子命令重试）');
      await p.mouse.click(area.x, area.y);
      await sleep(3000);
    };
    // 单槽上传：切槽 → 确保「双比例同步改动」未勾 → 上传 → 兼容性裁剪「确定」（新版无此步）
    const setSlot = async (slotTitleSrc, file, label) => {
      await openDialog();
      // 切槽必须点槽位 div 的画布区域（避开 title 行）——点 title 中心不触发切换，
      // 会导致第二张图覆盖第一张的槽（2026-10-07 二次实测踩坑后修正）
      const slot = await p.evaluate((src) => {
        const re = new RegExp(src);
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const canvas = [...document.querySelectorAll('.cover-editor-panel-canvas > div')]
          .find((d) => vis(d) && d.querySelector('.cover-editor-panel-canvas-title') && re.test((d.querySelector('.cover-editor-panel-canvas-title').textContent || '')));
        if (!canvas) return null;
        const r = canvas.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + Math.min(r.height * 0.6, 200), cls: canvas.className };
      }, slotTitleSrc);
      if (slot) { await p.mouse.click(slot.x, slot.y); await sleep(1500); }
      else console.warn(label + '：未定位到槽位「' + slotTitleSrc + '」，按当前槽继续');
      const sync = await p.evaluate(() => {
        const lab = document.querySelector('label.sync-checkbox.bcc-checkbox') || document.querySelector('.sync-checkbox-wrapper');
        const inp = lab ? lab.querySelector('input[type=checkbox]') : null;
        if (!inp) return { found: false, checked: false };
        if (!inp.checked) return { found: true, checked: false };
        const r = lab.getBoundingClientRect();
        return { found: true, checked: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (sync.checked) { await p.mouse.click(sync.x, sync.y); console.log('已取消「双比例同步改动」（' + label + '）'); await sleep(800); }
      // 2026-10-22（坑位⑭）：点上传入口后 filechooser 偶发唤不起来 → 最多点 3 次，
      //   每次**重新取入口坐标**；3 次全失败才退回「弹窗内图片 input 直塞」（原兜底语义保留）。
      //   ⚠ 从「合成 dispatchEvent click」改成**真实 mouse.click**（仓库惯例：合成 click
      //     在别处会重置整页表单）。为让真实点击落点准确，候选里取**面积最小**的可见元素
      //     ——点文字本身，不是那个大容器。
      const locateCoverEntry = async () => p.evaluate(() => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const cands = [];
        for (const el of document.querySelectorAll('.bcc-upload.cover-upload span, .bcc-upload.cover-upload div, .bcc-dialog div, .bcc-dialog span')) {
          if (/^上传封面$/.test((el.textContent || '').trim()) && vis(el)) cands.push(el);
        }
        if (!cands.length) {
          for (const el of document.querySelectorAll('.bcc-dialog div,span,button,a,label')) {
            const t = (el.textContent || '').trim();
            if (/上传封面|添加封面/.test(t) && vis(el) && el.getBoundingClientRect().height < 80) cands.push(el);
          }
        }
        if (!cands.length) return null;
        cands.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return ra.width * ra.height - rb.width * rb.height;
        });
        const r = cands[0].getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      let fc = null;
      try {
        fc = await pickFileWithRetry(p, locateCoverEntry, { attempts: 3, timeout: 8000, step: 'bilibili-cover' });
      } catch (e) {
        log.warn(label + '：filechooser 3 次都没唤起（' + e.message + '）→ 退回 input 直塞');
        fc = null;
      }
      if (!fc) {
        const imgInput = await p.$('.bcc-dialog input[type=file][accept*="image"]').catch(() => null) || await p.$('input[type=file][accept*="image"]');
        if (!imgInput) throw new Error(label + '：「上传封面」未触发 filechooser 且无图片 input 可直塞');
        await imgInput.setInputFiles(file);
        console.log(label + ' 已提交（input 直塞回退）:', path.basename(file));
      } else {
        await fc.setFiles(file);
        console.log(label + ' 已提交:', path.basename(file));
      }
      await sleep(4000);
      for (let i = 0; i < 3; i++) {
        const btn = await p.evaluate(() => {
          const el = [...document.querySelectorAll('button.bcc-button--primary')].find((x) => (x.textContent || '').trim() === '确定' && x.getBoundingClientRect().width > 0);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!btn) break;
        await p.mouse.click(btn.x, btn.y);
        console.log('封面「确定」已点（第 ' + (i + 1) + ' 次，' + label + '）');
        await sleep(3000);
      }
    };
    await setSlot('首页推荐封面', coverFile, '4:3 封面');
    if (cover16File) await setSlot('个人空间封面', cover16File, '16:9 封面');
    // 轮询等可见「完成」退出弹窗（应用两槽图）——注意「完成」不是 button 而是 div（2026-09-16 实测），
    //     必须任意元素文本匹配；新版编辑器上传后无「确定」步，直接「完成」即应用保存
    const closeDialog = async () => {
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        const fin = await p.evaluate(() => {
          const el = [...document.querySelectorAll('*')].filter((x) => (x.textContent || '').trim() === '完成' && x.children.length === 0 && x.getBoundingClientRect().width > 0).pop();
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (fin) {
          await p.mouse.click(fin.x, fin.y);
          await sleep(2000);
          const still = await p.evaluate(() => !![...document.querySelectorAll('.bcc-dialog')].find((x) => /封面制作/.test(x.textContent || '') && x.getBoundingClientRect().width > 0));
          if (!still) { console.log('封面弹窗「完成」已点'); return true; }
        }
      }
      return false;
    };
    await closeDialog();
    await sleep(2000);
    // 外层预览验证：封面设置区背景图出现（archive 域新图）——注意此检查有假阳性历史
    //     （2026-10-07 实测：检出 true 但两槽实空），故其后必须重开弹窗做双槽 canvas 终验
    const ok = await p.evaluate(() => {
      const zone = document.querySelector('.cover-main');
      if (!zone) return false;
      return [...zone.querySelectorAll('*')].some((d) => d.style && d.style.backgroundImage && d.style.backgroundImage !== 'none');
    });
    console.log(ok ? '封面外层预览已检出 ✓' : '警告：封面背景图未检出，请人工核对截图');
    // 重开弹窗双槽终验：上传的图保存在各槽 canvas 里（img/背景图检测不可靠），
    //     两槽 canvas 齐备 + 日志回显才算铁证；终验后幂等「完成」关闭弹窗
    await openDialog();
    const slots = await p.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const dlg = [...document.querySelectorAll('.bcc-dialog')].find((x) => /封面制作/.test(x.textContent || '') && vis(x));
      if (!dlg) return [];
      return [...dlg.querySelectorAll('.cover-editor-panel-canvas > div')]
        .filter((d) => vis(d) && d.querySelector('.cover-editor-panel-canvas-title'))
        .map((d) => ({ title: (d.querySelector('.cover-editor-panel-canvas-title').textContent || '').trim().slice(0, 12), hasCanvas: d.querySelectorAll('canvas').length > 0 }));
    });
    console.log('封面双槽终验:', JSON.stringify(slots));
    const slotsOk = slots.length >= 2 && slots.every((s) => s.hasCanvas);
    if (!slotsOk) console.warn('警告：双槽 canvas 不齐（期望 4:3+16:9 各一），请人工核对截图 ' + shotPath('bilibili.png'));
    await closeDialog();
    console.log(slotsOk && ok ? '封面已用自定义图落表单 ✓（' + (cover16File ? '4:3+16:9 双图分传' : '仅 4:3') + '）' : '警告：封面终验未全过，请人工核对截图');
    if (slotsOk && ok) log.step('封面', (cover16File ? '4:3+16:9 双图分传' : '仅 4:3') + '（双槽 canvas 终验✓）');
    else log.warn('封面终验未全过 —— 请人工核对截图 ' + shotPath('bilibili.png'));
  } else {
  // 原推荐帧路径
  const frame = await p.evaluate(() => {
    const zone = [...document.querySelectorAll('div')].find((d) => /以下为系统推荐封面/.test(d.textContent) && d.querySelectorAll('img').length > 0 && d.getBoundingClientRect().height < 400);
    const imgs = zone ? [...zone.querySelectorAll('img')] : [...document.querySelectorAll('img')].filter((im) => im.src.includes('hdslb.com') && im.width > 60 && im.getBoundingClientRect().top > 380 && im.getBoundingClientRect().top < 620);
    const im = imgs[0];
    if (!im) return null;
    const r = im.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (frame) {
    await p.mouse.click(frame.x, frame.y);
    await sleep(3000);
    const done = await p.evaluate(() => {
      const e = [...document.querySelectorAll('*')].find((x) => x.textContent.trim() === '完成' && x.children.length === 0 && x.getBoundingClientRect().width > 0);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (done) {
      await p.mouse.click(done.x, done.y);
      await sleep(3500);
      console.log('封面已用推荐帧确认');
    }
  } else console.warn('推荐封面帧未定位到，封面留人工');
  }
  // 8) 截图，停「提交投稿」前
  await shot(p, SHOT);
  console.log('screenshot →', SHOT);
  console.log('STATUS: 已停在「提交投稿」按钮前，等待用户点击提交');
  log.step('已停在「提交投稿」前', SHOT);
  log.finish('ok');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e.message);
  // 异常路径也要把日志收尾（耗时表 + 告警汇总），否则失败时反而没有留痕
  if (log) { try { log.finish('failed'); } catch (_) { /* 收尾失败不影响主流程 */ } }
  process.exit(1);
});
