// platforms/weibo.cjs — 微博视频发布填单脚本（patchright + CDP 连接外部 Chrome）
//
// ── 用途 ────────────────────────────────────────────────────────────
// 把已经生成好的视频物料（mp4、标题、描述 txt、封面图）填进微博的视频投稿表单：
// 传片 → 补选必填项（类型/内容声明/标题）→ 正文与话题 → 分类频道 → 封面，
// 最后截图留档并停在「发送」按钮前。
//
// ── 用法（在 publish-kit 目录下执行）─────────────────────────────────
//   node platforms/weibo.cjs --video <mp4> --title "<标题>" --body-file <描述.txt> [--cover <png>]
//   node platforms/weibo.cjs cover --cover <png>
//       封面补投模式：只对已填单的 upload/channel 标签页重设封面
//       （--cover 在一条龙里失败时单独重跑这条）。
//   node platforms/weibo.cjs fill --title "<标题>" --body-file <描述.txt>
//       表单补填模式（2026-10-14 加）：视频已在 upload/channel 页、只字段被清空时，
//       复用该页重填 类型/内容声明/标题/正文话题/分类；不导航、不关页、不重传视频、
//       不碰封面（合成 click 会重置表单，见 09-21 坑位）。
//       ⚠ 正文是 keyboard.type 直输、没有先清空（weibo 正文无 select-all 语义），
//       所以本模式**只适用于正文为空**的补填；对已有正文的页面跑会把文字叠加两遍。
//   node platforms/weibo.cjs channel --channel "科技数码" [--sub "科技"]
//       仅补选分类频道（2026-10-15 加）：复用现有 upload/channel 页，只做级联下拉这一件事，
//       不导航、不关页、不碰视频/封面/标题/正文——交割后只想改分类时用它。
//   --channel "<一级频道>" [--sub "<二级子频道>"]  一条龙模式下也可显式传分类（优先于 config）
//   --keep-tabs
//       保留所有遗留微博标签页不动，另开新页做视频（2026-10-19 加）。
//       场景：同一账号下已有一个**已填好并交割给用户**的微博页（如九宫格图文），
//       默认行为会把它连同已填内容一起关掉。开启后交割护栏只检查新开的这一页。
//   --cover  传自定义封面（2026-09-21 经实测确定：微博用竖封面 3:4，非 16:9）
//
// ── 依赖处理方式 ────────────────────────────────────────────────────
//   1) patchright：走本包 node_modules（require('patchright')），不引用包外任何绝对路径；
//      未安装时先在 publish-kit 目录跑 npm install。
//   2) 浏览器：connectOverCDP 连一个已用 --remote-debugging-port 启动的 Chrome，
//      地址取 config.yaml 的 runtime.cdp_url（也可用环境变量 CDP_URL 临时覆盖）。
//      登录态由那个 Chrome 的 profile 目录负责（config.yaml 的 runtime.profile_dir），
//      本脚本不碰、不创建、不迁移任何浏览器 profile。
//   3) lib/config.cjs：分类频道与 AI 声明的唯一来源。留空 = 不碰该字段 + 控制台告警，
//      脚本永远不猜一个值替你填上（见 lib/config.cjs 顶部的契约说明）。
//   4) lib/bigfile-upload.cjs：>48MB 的大文件自动改走 CDP 原生直传，绕开驱动 50MB 上限。
//      微博上传页的 UI 必须走「点按钮 → 原生 filechooser」，这里用
//      resolveOpenFileChooser 接住事件后仍改走 CDP 原生直传。
//
// ── 契约（最重要的一条）──────────────────────────────────────────────
//   本脚本只做填单，绝不点击「发送」，发布由用户本人完成。
//   另有一条交割护栏：页面上已有文字的表单视为已交割给用户，拒绝重填（确需重填加 --force）；
//   fill 模式是这套护栏的例外——它正是要重填一个被清空的表单。
//
//   本工具不对特定平台做自动化；是否接入某平台由使用者自行判断并承担后果。
//
// ── 流程 ────────────────────────────────────────────────────────────
// 微博专用视频上传页 https://weibo.com/upload/channel（2026-09-18 起为视频投稿表单：
//       点「上传视频」按钮拦截原生 filechooser 上传 mp4 → 等上传完成 → 投稿表单必填项
//       最小化补选（类型=原创、内容声明=含AI生成内容（按 publish.declare_ai）、标题 p.fill）
//       → composer textarea 填简介（标题并入正文）
//       → 分类频道（按 platforms.weibo.channel_hint，未配置则跳过+告警）
//       → [--cover: 上传封面→裁剪→完成] → 停「发送」前。
//       （2026-09-17 初版为 composer 直接 setInputFiles，当晚页面改版后失效。）
//
// 2026-09-25 重摸加固：入口=文本精确匹配+面积最小元素（外层容器中心是预览图，点它无效）；
//       cropper 确认按钮只认 BUTTON 轮询 30s；「input 直塞回退」废除（绕 UI 后 cropper 不出现）；
//       一次性全新页策略（遗留页 composer 草稿恢复会致旧文追加污染）；护栏改全量 textarea 检测。
//
// ── 坑位（经实测确认）────────────────────────────────────────────────
//   点发送前应确认缩略图为视频模式（带播放标识）而非纯图片。
//   微博页面对 a 标签入口（如「上传封面」）必须真实 mouse.click，dispatchEvent 合成
//   click 会触发默认行为导致表单重置（2026-09-21 实测）。
//   tag 形态（2026-09-22）：body 内 #词 空格分隔的纯文本，微博正文自动解析为话题；
//   联想下拉点选已实验（_item_ 候选+自动补 #词#）但新品词无候选+前缀替换碎片问题，
//   故对无精确候选的词降级为纯文本组接尾（2026-09-22 夜）。
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { chromium } = require('patchright');
const { setVideoFile, resolveOpenFileChooser } = require('../lib/bigfile-upload.cjs');

// 截图统一落 config.yaml 的 publish.screenshot_dir（不写死在脚本旁边）
const shotPath = (name) => path.join(cfg.screenshotDir(), name);

// ── 分类频道（2026-10-15 按实锤 DOM 重写）────────────────────────────
// 微博 upload/channel 的分类是**级联双栏**下拉：左栏一级频道(_item1_)、右栏是该
// 一级频道的二级子频道(_item2_)。三个实测要点，都是踩过的坑：
//   ① 点一级只切右栏、不选中（点「科技数码」后控件仍显示「请选择合适的频道」，
//      右栏换成 评测开箱/手机平板/电脑装机/摄影摄像/影音智能/科技/数码综合）；
//      必须再点二级才落值。
//   ② **悬停不触发切换**，必须 mouse.click；且两级列表各自可滚动，取坐标前要
//      scrollIntoView 再重取 rect——不滚动的话坐标落在滚动容器裁剪区外，点了没反应。
//   ③ 同名子项跨频道重复（「美食」「时尚美妆」在 VLOG 和 生活 下都有），只按文案
//      匹配会选到隔壁频道的分类上去。所以默认按「一级 + 二级」两级点，
//      并且**不指定 sub 又有多于一个子项时直接判失败**，不盲选第一个
//      （旧逻辑取「第一个可见 _item2_」正是这个隐患）。
// readback 只信控件最终显示值，且要求与「二级名」或「一级名」双向包含匹配——
// 不拿「点到的那个元素的 textContent」当期望值，那是自证不是校验。
async function selectChannel(p, channel, sub) {
  // 面板未开则点开；已开直接返回 'already'
  const ensureOpen = () => p.evaluate(() => {
    if ([...document.querySelectorAll('[class*="_item1_"]')].some((e) => e.offsetParent !== null)) return 'already';
    const vis = (el) => el && el.offsetParent !== null;
    const lab = [...document.querySelectorAll('*')]
      .find((el) => vis(el) && el.childElementCount === 0 && (el.textContent || '').trim() === '分类');
    const row = lab && lab.parentElement;
    const sel = row && [...row.querySelectorAll('[class*="wbpro-select"]')].filter(vis)[0];
    if (!sel) return null;
    sel.scrollIntoView({ block: 'center' });
    const r = sel.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 20) };
  });
  // 定位列表项：先滚到容器中间再取坐标，并回报是否真在视口内
  const locate = (cls, text) => p.evaluate(({ cls, text }) => {
    const vis = (el) => el && el.offsetParent !== null;
    const el = [...document.querySelectorAll(`[class*="${cls}"]`)]
      .filter(vis).find((e) => (e.textContent || '').trim() === text);
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return {
      x: r.x + r.width / 2, y: r.y + r.height / 2,
      inView: r.height > 4 && r.top >= 0 && r.bottom <= innerHeight,
    };
  }, { cls, text });
  const listLv = (cls) => p.evaluate((cls) => {
    const vis = (el) => el && el.offsetParent !== null;
    return [...new Set([...document.querySelectorAll(`[class*="${cls}"]`)]
      .filter(vis).map((e) => (e.textContent || '').trim()).filter(Boolean))];
  }, cls);
  const readDisplay = () => p.evaluate(() => {
    const vis = (el) => el && el.offsetParent !== null;
    const lab = [...document.querySelectorAll('*')]
      .find((el) => vis(el) && el.childElementCount === 0 && (el.textContent || '').trim() === '分类');
    const row = lab && lab.parentElement;
    const sel = row && [...row.querySelectorAll('[class*="wbpro-select"]')].filter(vis)[0];
    const val = sel && sel.querySelector('.woo-box-item-flex');
    return val ? (val.textContent || '').trim().slice(0, 40) : null;
  });

  let last = { ok: false, diag: '', display: null, clicked2: null };
  for (let round = 1; round <= 3 && !last.ok; round++) {
    const c = await ensureOpen();
    if (!c) return { ok: false, diag: '分类控件未定位（表单未展开？）', display: null, clicked2: null };
    if (c !== 'already') { await p.mouse.click(c.x, c.y); await sleep(1500); }

    let pos = await locate('_item1_', channel);
    if (!pos) { last = { ok: false, diag: '下拉里没有一级频道「' + channel + '」', display: await readDisplay(), clicked2: null }; await sleep(1200); continue; }
    await sleep(500);
    pos = await locate('_item1_', channel);
    if (!pos || !pos.inView) { last = { ok: false, diag: '一级频道「' + channel + '」滚动后仍不在视口内', display: null, clicked2: null }; await sleep(1200); continue; }
    await p.mouse.click(pos.x, pos.y);
    await sleep(1600);

    const lv2 = await listLv('_item2_');
    let clicked2 = null;
    if (sub) {
      pos = await locate('_item2_', sub);
      if (!pos) { last = { ok: false, diag: '二级「' + sub + '」不在一级「' + channel + '」的子列表（现有: ' + lv2.join('/') + '）', display: null, clicked2: null }; await sleep(1200); continue; }
      await sleep(400);
      pos = await locate('_item2_', sub);
      if (!pos || !pos.inView) { last = { ok: false, diag: '二级「' + sub + '」滚动后仍不在视口内', display: null, clicked2: null }; await sleep(1200); continue; }
      await p.mouse.click(pos.x, pos.y);
      clicked2 = sub;
      await sleep(1600);
    } else if (lv2.length === 1) {
      pos = await locate('_item2_', lv2[0]);
      if (pos && pos.inView) { await p.mouse.click(pos.x, pos.y); clicked2 = lv2[0]; await sleep(1600); }
    } else if (lv2.length > 1) {
      last = {
        ok: false,
        diag: '一级「' + channel + '」下有 ' + lv2.length + ' 个二级子项（' + lv2.join('/') + '），未指定 --sub 不盲选——请显式指定',
        display: null, clicked2: null,
      };
      await sleep(1200);
      continue;
    }

    const back = await readDisplay();
    const expect = [sub, channel].filter(Boolean);
    const ok = !!back && back.length >= 2
      && expect.some((e) => back === e || e.includes(back) || back.includes(e));
    last = { ok, diag: ok ? '' : '回读未确认（控件显示: ' + JSON.stringify(back) + '）', display: back, clicked2 };
    if (!ok) await sleep(1200);
  }
  return last;
}

// ── 内容声明（2026-10-19 重写）────────────────────────────────────────
// 旧实现按文案「请进行内容声明」去找一个弹窗里的复选框，2026-10-19 实测页面已改版：
// 声明变成一个 wbpro-select 下拉，触发器文案就是「含AI生成内容」（灰色占位），
// 面板里的选项文案同样是「含AI生成内容」（class _optionLabel_），末尾有「确定」按钮。
// 旧逻辑因为找不到「请进行内容声明」而**整段静默跳过**，却照样打印「声明已补选」——
// 假阳性。
//
// 三个实测坑（都已踩过）：
// ① **不能用坐标点**：面板与表单位置随页面滚动漂移，点空/点到面板外，
//    面板会「关掉」但值没提交（outside-click 关闭与点「确定」关闭长得一样，极易误判）。
//    改用页面内 el.click()——面板里是 <button>，JS click 不会触发导航/表单重置。
// ② **触发器是 toggle**：面板已开着时再点它会把面板**点关**。要先判断面板开没开。
// ③ **不能用控件外观判读**（2026-10-19 实测）：选项文案与占位符文案完全相同
//    （都是「含AI生成内容」），触发器灰色是组件基色、select 的 error 类也是静态类名
//    （未填的「分类」select 同样带 error），三者都判不出真假。
//    唯一可靠的判据是**面板里的单选态**：重开面板后目标选项仍带 _checkActive。
async function selectStatement(p) {
  const readPanel = () => p.evaluate(() => {
    const panel = [...document.querySelectorAll('[class*="_panel_"]')].find((e) => /我的内容无需声明/.test(e.textContent || '') && e.getBoundingClientRect().width > 0);
    const active = panel
      ? [...panel.querySelectorAll('button')].filter((b) => b.querySelector('[class*="_checkActive"]')).map((b) => (b.textContent || '').trim())
      : [];
    return { open: !!panel, active };
  });
  const triggerClick = () => p.evaluate(() => {
    const sels = [...document.querySelectorAll('.wbpro-select, [class*="wbpro-select"]')];
    for (const s of sels) {
      const t = s.querySelector('[class*="triggerText"]');
      if (!t || !/AI生成/.test((t.textContent || '').trim())) continue;
      t.click();
      return true;
    }
    return false;
  });

  // 1) 打开面板（已开就别再点触发器，那是 toggle）
  let st = await readPanel();
  if (!st.open) {
    if (!await triggerClick()) return { ok: false, diag: '未找到「内容声明」下拉触发器' };
    await sleep(1500);
    st = await readPanel();
    if (!st.open) return { ok: false, diag: '点击触发器后面板未展开' };
  }
  // 2) 选目标选项（已选则不重复点）
  if (!st.active.includes('含AI生成内容')) {
    const r = await p.evaluate(() => {
      const panel = [...document.querySelectorAll('[class*="_panel_"]')].find((e) => /我的内容无需声明/.test(e.textContent || '') && e.getBoundingClientRect().width > 0);
      if (!panel) return 'no panel';
      const b = [...panel.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '含AI生成内容');
      if (!b) return 'no option';
      b.click();
      return 'clicked';
    });
    if (r !== 'clicked') return { ok: false, diag: '面板里未找到选项「含AI生成内容」（' + r + '）' };
    await sleep(900);
  }
  // 3) 点「确定」
  const r3 = await p.evaluate(() => {
    const panel = [...document.querySelectorAll('[class*="_panel_"]')].find((e) => /我的内容无需声明/.test(e.textContent || '') && e.getBoundingClientRect().width > 0);
    if (!panel) return 'no panel';
    const b = [...panel.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '确定');
    if (!b) return 'no confirm';
    b.click();
    return 'clicked';
  });
  if (r3 !== 'clicked') return { ok: false, diag: '面板里未找到「确定」按钮（' + r3 + '）' };
  await sleep(1500);

  // 4) 回读：重开面板，目标选项必须仍带 _checkActive（值已绑进组件）
  await triggerClick();
  await sleep(1400);
  const after = await readPanel();
  await p.keyboard.press('Escape').catch(() => {});
  await sleep(400);
  const ok = after.open && after.active.includes('含AI生成内容');
  return {
    ok,
    diag: ok ? '' : '回读未确认（面板单选态: ' + JSON.stringify(after.active) + '）',
    display: '含AI生成内容',
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      // 布尔开关（如 --keep-tabs）：后面不跟值时置 true，避免吞掉下一个 --xxx
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(argv[i]);
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];
  const coverOnly = sub === 'cover';
  // fill 模式（2026-10-14）：视频仍在页上、仅字段被清空时的补填。
  // 与 cover 模式同样「复用现有 upload/channel 标签页」，但不碰封面，且跳过交割护栏
  // （护栏本来是拦「已填好被人接管」的页；这里恰恰是要重填一个空表单）。
  const fillOnly = sub === 'fill';
  // channel 模式（2026-10-15）：交割后只补分类频道，其余字段一律不碰。
  const channelOnly = sub === 'channel';
  // statement 模式（2026-10-19 加）：交割后只补「内容声明」，其余字段一律不碰。
  const statementOnly = sub === 'statement';
  if (sub && !coverOnly && !fillOnly && !channelOnly && !statementOnly) throw new Error('未知子命令: ' + sub);
  const CDP = process.env.CDP_URL || cfg.cdpUrl();
  if (coverOnly) {
    if (!args.cover || !fs.existsSync(args.cover)) throw new Error('cover 模式缺 --cover 或文件不存在');
  } else if (fillOnly) {
    if (!args.title) throw new Error('fill 模式缺 --title');
    if (!args['body-file'] || !fs.existsSync(args['body-file'])) throw new Error('fill 模式缺 --body-file 或文件不存在');
  } else if (channelOnly) {
    if (!args.channel) throw new Error('channel 模式缺 --channel "<一级频道>"（子频道用 --sub "<二级>"）');
  } else if (statementOnly) {
    // statement 模式无必填参数：只补内容声明
  } else {
    if (!args.video || !fs.existsSync(args.video)) throw new Error('缺 --video 或文件不存在');
    if (!args['body-file'] || !fs.existsSync(args['body-file'])) throw new Error('缺 --body-file');
  }
  // 结尾截图统一落 publish.screenshot_dir（目录不存在即建）
  fs.mkdirSync(cfg.screenshotDir(), { recursive: true });
  const SHOT = shotPath(channelOnly ? 'weibo-channel.png' : 'weibo.png');
  const body = args['body-file'] ? fs.readFileSync(path.resolve(args['body-file']), 'utf-8').trim() : '';
  const text = args.title ? `${args.title}\n${body}` : body;

  const browser = await chromium.connectOverCDP(CDP, { timeout: 15000 });
  const ctx = browser.contexts()[0];
  const weiboTabs = ctx.pages().filter((x) => /weibo\.com/.test(x.url()) && !/passport/.test(x.url()));
  let p = null;
  if (coverOnly || fillOnly || channelOnly || statementOnly) {
    p = weiboTabs.find((x) => /upload\/channel/.test(x.url()));
    if (!p) throw new Error((channelOnly ? 'channel' : statementOnly ? 'statement' : fillOnly ? 'fill' : 'cover') + ' 模式：未找到已打开的 weibo.com/upload/channel 标签页（先跑一条龙把视频传上）');
  } else {
    // 2026-10-19 加 --keep-tabs：同一账号下已经有一个**已填好并交割给用户**的微博页
    // （如九宫格图文）时，关闭遗留标签会把那个页面连同已填内容一起毁掉。
    // --keep-tabs = 保留所有遗留标签页不动，另开新页做视频；代价是交割护栏
    // 不能再扫全部标签（会误判已交割页），改为**只护栏新开的这一页**。
    const keepTabs = !!args['keep-tabs'];
    if (!keepTabs) {
      // 交割护栏（2026-09-25 加固）：全量 textarea/contenteditable 检测，阈值 10 字。
      // 旧选择器（placeholder*="新鲜事"/_input_）测不到投稿页 composer，导致遗留页旧文后追加（当日实证）。
      if (!process.argv.includes('--force')) {
        for (const t of weiboTabs) {
          const filled = await t.evaluate(() => [...document.querySelectorAll('textarea, [contenteditable="true"]')]
            .map((e) => ((e.value || e.textContent || '')).trim())
            .filter((s) => s.length > 10)
            .map((s) => s.slice(0, 30))).catch(() => []);
          if (filled.length) throw new Error('[交割护栏] 微博页已有文字（疑似已交割或遗留草稿）:' + JSON.stringify(filled) + '。请人工关闭该标签页后重跑；确认页面可弃加 --force；若要保留已交割页请加 --keep-tabs。');
        }
      }
      // 全新页策略（2026-09-25）：遗留页 composer 有草稿恢复机制，reload 后旧文复活并混入新填文字——
      // 一律关闭遗留 weibo 标签、开新页，从根上杜绝追加污染。
      for (const t of weiboTabs) await t.close().catch(() => {});
    }
    p = await ctx.newPage();
    await p.goto('https://weibo.com/upload/channel', { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(8000);
    if (/passport\.weibo|signin|newlogin/.test(p.url())) throw new Error('微博未登录: ' + p.url());
    if (keepTabs) {
      // 只护栏新页：新开页若把草稿恢复出来了（旧文），同样不能让它混进新填正文
      const filled = await p.evaluate(() => [...document.querySelectorAll('textarea, [contenteditable="true"]')]
        .map((e) => ((e.value || e.textContent || '')).trim())
        .filter((s) => s.length > 10)
        .map((s) => s.slice(0, 30))).catch(() => []);
      if (filled.length) throw new Error('[交割护栏] 新开的微博视频页已有文字（草稿恢复混入）:' + JSON.stringify(filled) + '。请人工清空该页后重跑；确认可弃加 --force。');
      console.log('--keep-tabs：已保留 ' + weiboTabs.length + ' 个遗留微博标签页，新页护栏 ✓（无草稿恢复文字）');
    }
  }

  // 1) 上传视频（2026-09-18 起：upload/channel 改为投稿表单，setInputFiles 不再触发上传，
  //    必须点「上传视频」按钮 + 拦截原生 filechooser；失败再回退 setInputFiles）
  //    cover / fill / channel 三种补投模式整段跳过（视频已在页面上）
  if (!coverOnly && !fillOnly && !channelOnly && !statementOnly) {
  const videoPath = path.resolve(args.video);
  let videoConfirmed = false;
  try {
    const btn = await p.waitForSelector('button:has-text("上传视频")', { timeout: 15000 });
    const chooserPromise = p.waitForEvent('filechooser', { timeout: 10000 });
    await btn.click();
    const chooser = await chooserPromise;
    // 大文件不能走 chooser.setFiles（50MB 上限），但 UI 又必须由这个 chooser 触发，
    // 所以接住事件后改用原生 CDP 给同一个 file input 赋值（2026-09-28 大文件实测）。
    const viaCdp = await resolveOpenFileChooser(p, videoPath);
    if (!viaCdp) await chooser.setFiles(videoPath);
    videoConfirmed = true;
    console.log(`视频已提交（filechooser${viaCdp ? ' + CDP 原生直传' : ''}），等待上传完成…`);
  } catch (e) {
    const input = await setVideoFile(p, 'input[type=file][accept*="video/mp4"]', videoPath, 0, { timeout: 10000 });
    console.log(`视频已提交（input 直传 ${input} 通道），等待缩略图…`);
  }
  // 等上传完成。判定必须有正面 DOM 证据：表单内出现 <video> 元素——
  // 仅凭页面文本「上传完成」会假阳性（2026-09-24 两次实证：文本命中但视频实际未进表单，用户两次看到空表单）
  // 等待窗口按体积自适应（2026-09-28）：≤3MB 走新闻线原有 3 分钟地板；每 MB 约 +3s，上限 12 分钟。
  // 55MB 的 2K 宣传片实测 3 分钟不够（t+168s 仍在传）——第一次修公式时把 ceil(mb/4) 写反了，
  // 被 max(60,·) 的地板值压回 3 分钟，等于没放宽；正确是 mb*3。
  const videoMb = fs.statSync(path.resolve(args.video)).size / (1024 * 1024);
  const totalTicks = Math.min(240, Math.max(60, Math.ceil(videoMb * 3)));
  const waitMin = Math.round((totalTicks * 3) / 60);
  let uploadVerified = false;
  for (let i = 0; i < totalTicks; i++) {
    await sleep(3000);
    const st = await p.evaluate(() => {
      const sig = document.body.innerText.replace(/\s+/g, ' ');
      // 2026-09-28 修正假阳性：空表单态下页面里也有 <video>，但 src 为空——只看标签存在
      // 会把「页面已重置回空白上传态」误判成上传成功（55MB 那次连续 8 分钟误报）。
      // 判据改为：① 有 src 的 video 或已出现表单必填项（类型/内容声明/标题）；
      //        ② 出现空白态特征文案立即判失败，不空转到超时。
      const vid = [...document.querySelectorAll('video')].find((v) => (v.currentSrc || v.src || '').length > 0);
      return {
        videoEl: !!vid,
        formUp: /类型|内容声明/.test(sig),
        done: /上传完成/.test(sig),
        uploading: /上传中|\d+\s*%/.test(sig),
        failed: /上传失败|重新上传/.test(sig),
        reset: /拖拽视频到此处也可上传/.test(sig),
        sigHead: sig.slice(0, 160),
      };
    }).catch(() => null);
    if (!st) continue;
    if (st.failed) throw new Error('微博页面提示上传失败，请人工重试');
    if (st.reset && !st.formUp) {
      throw new Error(`微博已静默回到空白上传态（t+${(i + 1) * 3}s），上传未生效。当前文件 ${videoMb.toFixed(1)}MB——`
        + '微博对大文件会静默失败且不报错，先出上传优化版（建议 ≤35MB）再重跑');
    }
    if ((st.videoEl || st.formUp) && st.done && !st.uploading) { console.log(`上传完成（t+${(i + 1) * 3}s，${st.videoEl ? 'video 元素有 src' : '表单已展开'}）`); uploadVerified = true; break; }
    if (i % 5 === 0) console.log(`上传中… t+${(i + 1) * 3}s（video 有 src: ${st.videoEl} / 表单已展开: ${st.formUp}）`);
  }
  if (!uploadVerified) {
    throw new Error(`微博上传 ${waitMin} 分钟内未在表单检出 <video> 元素，判上传失败（文本「上传完成」判定有假阳性前科，2026-09-24 两次实证）；请人工查看页面确认，必要时重跑`);
  }
  } // end !coverOnly && !fillOnly（视频上传段）
  // 1.4) fill 模式前置校验（2026-10-14）：视频必须真的还在页上才允许补填，
  //      否则就是在空白态上填一遍然后交割给用户（09-24 两次假阳性事故的同源教训）。
  if (fillOnly) {
    const alive = await p.evaluate(() => {
      const sig = (document.body.innerText || '').replace(/\s+/g, ' ');
      const vid = [...document.querySelectorAll('video')].find((v) => (v.currentSrc || v.src || '').length > 0);
      return { done: /上传完成/.test(sig), formUp: /类型|内容声明/.test(sig), vid: !!vid };
    }).catch(() => null);
    if (!alive || (!alive.done && !alive.formUp)) {
      throw new Error('fill 模式：当前 upload/channel 标签页没有已上传的视频（页面已被重置到空白态），'
        + '请改跑一条龙 `weibo.cjs --video … --title … --body-file …` 重新上传');
    }
    console.log('fill 模式：检测到视频仍在页上（上传完成=' + alive.done + '，video 有 src=' + alive.vid + '），开始补填字段');
  }
  if (!coverOnly && !channelOnly && !statementOnly) {
  // 2026-10-19 加：titleFieldFilled —— 视频投稿表单**有**独立「标题」输入框
  //      （2026-09-17 写脚本时按「微博无独立标题框」处理，把标题并进了正文首行）。
  //      2026-10-19 实测 upload/channel 表单有 input[placeholder*="标题"]（maxlength 30），
  //      标题与正文首行同时出现 = 读者看到两遍同一个标题。
  //      所以：填了标题框 → 正文不再带标题行；没填（首页九宫格那种无标题框的表单）→ 维持并入首行。
  let titleFieldFilled = false;
  // 1.5) 投稿表单必填项最小化补选（类型=原创、内容声明、标题）
  //      内容声明是否点选由 config.yaml 的 publish.declare_ai 决定（cfg.declareAi()，默认开）。
  //      关闭时整段跳过、不碰声明控件——平台侧是否强制要求声明由使用者自行判断，
  //      本工具不替他勾；但若稿件确含 AI 生成内容又不声明，平台侧会拦。
  const inForm = await p.evaluate(() => /类型|内容声明/.test(document.body.innerText.replace(/\s+/g, ' '))).catch(() => false);
  if (inForm) {
    await p.evaluate(() => {
      const ori = [...document.querySelectorAll('[class*="radio"], [class*="Radio"], label, span, div')].filter((e) => (e.textContent || '').trim() === '原创').pop();
      if (ori) ori.click();
    });
    await sleep(500);
    if (cfg.declareAi()) {
    // 2026-10-19 重写：旧代码按「请进行内容声明」找弹窗，页面改版后找不到就**静默跳过**，
    // 却照样打印「声明已补选」（假阳性）。现走 selectStatement()：定位下拉 → 点选项 →
    // 点确定 → 回读控件（error 类是否消失），没选上就大声报出来。
    const decl = await selectStatement(p);
    if (decl.ok) console.log('内容声明已选「含AI生成内容」✓（控件回读: ' + JSON.stringify(decl.display) + '）');
    else console.error('⚠ 内容声明未选中（' + decl.diag + '）——微博必填项，发送前请人工在下拉里选「含AI生成内容」');
    } else {
      console.log('publish.declare_ai = false，跳过内容声明（未碰声明控件；该稿件是否需要声明由你自己确认）');
    }
    const tSel = 'input[placeholder*="标题"], input[maxlength="30"]';
    if (await p.$(tSel)) {
      await p.fill(tSel, '');
      await p.fill(tSel, args.title || '');
      titleFieldFilled = true;
      console.log('投稿表单：类型/标题已补选，标题 =', await p.$eval(tSel, (e) => e.value));
    }
  }
  // 2) 文字（composer textarea）
  // 2026-09-30 修：微博 upload/channel 页新增「标题」框后页面变长，composer 常被推到
  // 视口外（实测 y=1287 vs 视口 907），原坐标 mouse.click 落空 → keyboard.type 打进无关
  // 元素 → 文字全丢，而「文字已填」固定输出造成假阳性（2026-09-30 实测：发布时正文为空）。
  // 先 scrollIntoView 把 composer 拉进视口再取坐标；type 后回读自证，空值即 FATAL。
  const box = await p.evaluate(() => {
    const e = document.querySelector('textarea[placeholder*="新鲜事"], [contenteditable="true"]');
    if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    return { x: r.x + 30, y: r.y + Math.min(30, r.height / 2) };
  });
  if (!box) throw new Error('未找到 composer 编辑区');
  if (box.y < 0 || box.y > 900) throw new Error('composer 不在视口内（y=' + Math.round(box.y) + '），滚动失败');
  await p.mouse.click(box.x, box.y);
  await sleep(800);
  // 3) 文字两轮法（2026-09-22）：正文直输；#tag 逐个「探测→选中」，无精确话题的以纯文本组接尾。
  //    微博联想为前缀替换式：未选中词残留会被后续点选整段吞掉产生碎片，故正式输入前先全量探测。
  //    候选稳定化：_item_ 候选 scrollIntoView({block:'center'}) + sleep 后双次取坐标（面板随
  //    textarea 高度浮动到视口外，坐标必须滚动后重取）。
  const composerSource = titleFieldFilled ? body : text;
  const bodyNorm = composerSource.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n');
  const main = bodyNorm.split('\n#')[0];
  const topicTags = (bodyNorm.match(/#[^\s#]+/g) || []).map((x) => x.slice(1));
  await p.keyboard.type(main, { delay: 2 });
  await p.keyboard.press('Control+End');
  await sleep(300);
  const findCand = async (kw) => {
    for (let i = 0; i < 6; i++) {
      await sleep(1000);
      const probe = await p.evaluate((name) => {
        let el = null;
        const walk = (root) => {
          if (el) return;
          for (const x of root.querySelectorAll('*')) {
            if (el) return;
            if (x.shadowRoot) walk(x.shadowRoot);
            const t = (x.textContent || '').trim();
            if (t === name && (x.className || '').toString().includes('_item_')) el = x;
          }
        };
        walk(document);
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        return { found: true, needScroll: r.y < 5 || r.y > 920, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, kw);
      if (!probe.found) continue;
      if (probe.needScroll) {
        await p.evaluate((name) => {
          let el = null;
          const walk = (root) => {
            if (el) return;
            for (const x of root.querySelectorAll('*')) {
              if (el) return;
              if (x.shadowRoot) walk(x.shadowRoot);
              const t = (x.textContent || '').trim();
              if (t === name && (x.className || '').toString().includes('_item_')) el = x;
            }
          };
          walk(document);
          if (el) el.scrollIntoView({ block: 'center' });
        }, kw);
        await sleep(900);
      }
      const pos = await p.evaluate((name) => {
        let el = null;
        const walk = (root) => {
          if (el) return;
          for (const x of root.querySelectorAll('*')) {
            if (el) return;
            if (x.shadowRoot) walk(x.shadowRoot);
            const t = (x.textContent || '').trim();
            if (t === name && (x.className || '').toString().includes('_item_')) el = x;
          }
        };
        walk(document);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.y < 5 || r.y > 960) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, kw);
      if (pos) return pos;
    }
    return null;
  };
  const recover = async () => {
    await p.keyboard.press('Escape');
    await sleep(400);
    await p.mouse.click(300, 400);
    await sleep(300);
    await p.click('textarea');
    await sleep(300);
    await p.keyboard.press('Control+End');
    await sleep(200);
  };
  // 探测轮：有精确话题的进 okTags，无的进 plainTags（探测后回删，正文不受影响）
  const okTags = [], plainTags = [];
  for (const kw of topicTags) {
    await p.keyboard.type('#' + kw, { delay: 110 });
    let found = false;
    for (let i = 0; i < 5 && !found; i++) {
      await sleep(1000);
      found = await p.evaluate((name) => {
        let res = false;
        const walk = (root) => {
          if (res) return;
          for (const el of root.querySelectorAll('*')) {
            if (res) return;
            if (el.shadowRoot) walk(el.shadowRoot);
            const t = (el.textContent || '').trim();
            if (t === name && (el.className || '').toString().includes('_item_') && el.getBoundingClientRect().width > 30) res = true;
          }
        };
        walk(document);
        return res;
      }, kw);
    }
    for (let k = 0; k < kw.length + 1; k++) { await p.keyboard.press('Backspace'); await sleep(25); }
    (found ? okTags : plainTags).push(kw);
  }
  await p.keyboard.press('Control+End');
  await sleep(300);
  // 正式轮：okTags 逐个联想点选（每次点选后 recover 破除面板死状态）
  let linked = 0;
  for (const kw of okTags) {
    await p.keyboard.press('End');
    await sleep(150);
    await p.keyboard.type('#' + kw, { delay: 110 });
    const pos = await findCand(kw);
    if (pos) {
      await p.mouse.click(pos.x, pos.y);
      await sleep(1300);
      linked++;
      await recover();
    } else {
      for (let k = 0; k < kw.length + 1; k++) { await p.keyboard.press('Backspace'); await sleep(25); }
      plainTags.push(kw);
      await recover();
    }
  }
  // plainTags 纯文本组一次性接尾（Escape 后输入，不触发联想替换）
  if (plainTags.length) {
    await p.keyboard.press('End');
    await sleep(150);
    await p.keyboard.type(' ' + plainTags.map((x) => '#' + x).join(' '), { delay: 60 });
    await p.keyboard.press('Escape');
    await sleep(500);
  }
  // 3.15) 标签行归一化（2026-10-19 加）：微博联想点选是**前缀替换式**，与「纯文本组接尾」
  //      混用会把尾行搅乱——2026-10-19 实测 10 个标签变成
  //      「#Anthropic# #英伟达 # 英伟达#MiniMax# #AI# #人工智能# 人工智能 #豆包 #宇树 …」
  //      （重复、残留 #、顺序乱）。这里做确定性归一：取最后一行 → 抽全部 #词 →
  //      去重（保序）→ 重建为「#词 #词 …」→ 写回 textarea 并派发 input 事件（让框架收到）。
  //      微博正文会自动把 #词 解析成话题，规整后不丢话题性。
  const tagFix = await p.evaluate(() => {
    const e = document.querySelector('textarea[placeholder*="新鲜事"], [contenteditable="true"]');
    if (!e || e.value === undefined) return { skipped: true, reason: '无 textarea' };
    const lines = e.value.split('\n');
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) { if ((lines[i] || '').trim()) { idx = i; break; } }
    if (idx < 0) return { skipped: true, reason: '空内容' };
    const last = lines[idx];
    if (!/#/.test(last)) return { skipped: true, reason: '末行无标签' };
    const seen = new Set(); const tags = [];
    for (const m of last.matchAll(/#([^\s#]+)/g)) {
      const t = (m[1] || '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t); tags.push(t);
    }
    if (!tags.length) return { skipped: true, reason: '抽不出标签' };
    const rebuilt = '#' + tags.join(' #');
    // ⚠ 只替换**标签部分**：微博联想的前缀替换会把结尾段和标签挤到同一行，
    //   整行替换会把结尾段一起吃掉（2026-10-19 实测踩到）。
    const at = last.indexOf('#');
    const head = at >= 0 ? last.slice(0, at) : '';
    const nextLine = head + rebuilt;
    if (last === nextLine) return { ok: true, unchanged: true, tags };
    lines[idx] = nextLine;
    e.value = lines.join('\n');
    e.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, tags, before: last.slice(0, 140), after: nextLine };
  });
  if (tagFix && tagFix.ok) {
    await sleep(600);
    const tail = await p.evaluate(() => {
      const e = document.querySelector('textarea[placeholder*="新鲜事"], [contenteditable="true"]');
      if (!e || e.value === undefined) return null;
      const ls = e.value.split('\n');
      for (let i = ls.length - 1; i >= 0; i--) { if ((ls[i] || '').trim()) return ls[i]; }
      return null;
    });
    const ok = tail === tagFix.after;
    console.log((ok ? '✓' : '✗') + ' 标签行归一化: ' + JSON.stringify(tagFix.tags) + (ok ? '' : '（回读不一致: ' + JSON.stringify(tail) + '）'));
  } else if (tagFix && tagFix.skipped) {
    console.log('标签行归一化跳过: ' + tagFix.reason);
  }
  // 回读自证（2026-09-30 加）：文字主体+话题全部输入后，回读 composer 实际内容，
  // 长度不达标即 FATAL——防止「文字已填」假阳性（09-30 期正文全丢仍报成功）。
  const verify = await p.evaluate(() => {
    const e = document.querySelector('textarea[placeholder*="新鲜事"], [contenteditable="true"]');
    if (!e) return { len: -1 };
    return { len: (e.value !== undefined ? e.value : e.innerText || '').length, head: (e.value !== undefined ? e.value : e.innerText || '').slice(0, 30) };
  });
  if (verify.len < 50) throw new Error('composer 回读 len=' + verify.len + '，文字未落表单（head=' + JSON.stringify(verify.head) + '）');
  console.log('文字已填（话题下拉选中 ' + linked + '，纯文本 ' + plainTags.length + '，回读 ' + verify.len + ' 字：' + JSON.stringify(verify.head) + '…）');
  // 3.2) 分类频道：级联双栏（结构与坑位见文件头 selectChannel 的注释）
  //      未配置 channel_hint 且命令行也没给 --channel → 整段跳过、不点下拉 + 告警。
  //      不内置任何默认分类：猜错的分类会静默落到发布页上，用户在发布前不一定会发现；
  //      留空的告警是一次明确提醒。
  const channel = args.channel || cfg.hint('weibo', 'channel_hint');
  const channelSub = args.sub || null;
  if (!channel) {
    cfg.warnSkipped('weibo', 'channel_hint', '微博分类频道');
  } else {
    try {
      const r = await selectChannel(p, channel, channelSub);
      if (r.ok) {
        console.log('分类频道已选（' + channel + (r.clicked2 ? ' / ' + r.clicked2 : '') + '，控件回读: ' + r.display + '）✓');
      } else {
        console.log('警告：分类频道填写失败（' + r.diag + '）——转人工，发布前请在表单手选「' + channel + '」');
      }
    } catch (e) {
      console.log('警告：分类频道填写失败（' + String(e.message || e).slice(0, 120) + '）——转人工，发布前请在表单手选「' + channel + '」');
    }
  }
  }
  if (channelOnly) {
    // channel 模式到此为止：只做了分类这一件事，不碰视频/封面/标题/正文。
    const r = await selectChannel(p, args.channel, args.sub || null);
    await p.screenshot({ path: SHOT });
    console.log('screenshot →', SHOT);
    if (!r.ok) {
      console.error('FATAL 分类频道未选中（' + r.diag + '）——表单未被改动，请人工在下拉里手选');
      process.exit(1);
    }
    console.log('分类频道已选（' + args.channel + (r.clicked2 ? ' / ' + r.clicked2 : '') + '，控件回读: ' + r.display + '）✓');
    console.log('STATUS: 已停在「发送」按钮前，等待用户点击发送');
    process.exit(0);
  }
  if (statementOnly) {
    // statement 模式到此为止：只做「内容声明」这一件事，不碰视频/封面/标题/正文/分类。
    const r = await selectStatement(p);
    // 先报结果再截图：微博页重，截图可能超时，不能让它盖掉真正的错误
    if (!r.ok) console.error('FATAL 内容声明未选中（' + r.diag + '）——请人工在「内容声明」下拉里选「含AI生成内容」');
    else console.log('内容声明已选「含AI生成内容」✓（控件回读: ' + JSON.stringify(r.display) + '）');
    await p.screenshot({ path: SHOT, timeout: 15000 }).catch((e) => console.log('截图失败（' + String(e.message || e).slice(0, 60) + '），跳过留档'));
    console.log('screenshot →', SHOT);
    if (!r.ok) process.exit(1);
    console.log('STATUS: 已停在「发送」按钮前，等待用户点击发送');
    process.exit(0);
  }
  // 3.5) 自定义封面（--cover；微博用竖封面 3:4，2026-09-21 经实测确定）
  // fill 模式显式跳过封面：封面已在页上，且上传封面的入口必须真实 mouse.click
  // （合成 click 会重置整页表单，09-21 实测），在补填场景里没必要冒这个险。
  // 2026-09-25 重摸结论（四轮 DOM 侦查）：
  // ① 入口 DOM 改版：预览大图容器（132×176）内含 <A>上传封面 + <A>裁剪封面 两个小链接；
  //    文本模糊匹配 .find() 会命中外层容器，其中心点 elementFromPoint=预览 IMG，点击无效
  //    →filechooser 不弹 →cropper 不出现→全页找「完成」FATAL（当日三次失败同根因）。
  //    修法：正则精确匹配 + 面积最小元素 + scrollIntoView + elementFromPoint 遮挡检查。
  // ② cropper 弹窗 t+3~6s 出现，确认按钮为 BUTTON.woo-button-*（容器 wbpro-layer-btn）。
  // ③「input 直塞回退」废除：绕过 UI 提交后 cropper 永不出现，必 FATAL，还白耗等待。
  // ④ 危险元素：上传完成条右侧有「删除」链接，盲点会清空整个表单（实测出现过「跳回未发布状态」）。
  // ⑤ 2026-09-28：封面弹窗内上传入口的实测文案是「本地上传」（不是「上传封面」），
  //    旧正则漏了它 → 报「入口未找到（表单未展开？）」误导，实际弹窗已经开着。已并入匹配集。
  if (args.cover && !fillOnly) {
    const coverFile = path.resolve(args.cover);
    if (!fs.existsSync(coverFile)) throw new Error('--cover 文件不存在: ' + args.cover);
    const locateEntry = async () => {
      await p.evaluate(() => {
        const all = [...document.querySelectorAll('a,div,span,button')].filter((x) => /^(上传封面|本地上传|添加封面|更换封面)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0);
        if (!all.length) return;
        const el = all.sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height))[0];
        el.scrollIntoView({ block: 'center' });
      });
      await sleep(800);
      return p.evaluate(() => {
        const all = [...document.querySelectorAll('a,div,span,button')].filter((x) => /^(上传封面|本地上传|添加封面|更换封面)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0);
        if (!all.length) return null;
        const el = all.sort((a, b) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height))[0];
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        if (!top || !(el.contains(top) || top.contains(el))) return { misHit: top ? top.tagName + '.' + String(top.className).slice(0, 40) : 'none' };
        return { x: cx, y: cy };
      });
    };
    let fc = null;
    for (let attempt = 0; attempt < 2 && !fc; attempt++) {
      const pos = await locateEntry();
      if (!pos) throw new Error('「上传封面」入口未找到（表单未展开？）');
      if (pos.misHit) throw new Error('入口被遮挡（elementFromPoint=' + pos.misHit + '）——禁止盲点：误点「删除」会清空表单（2026-09-25 实证）。请人工上传封面。');
      try {
        [fc] = await Promise.all([
          p.waitForEvent('filechooser', { timeout: 15000 }),
          p.mouse.click(pos.x, pos.y),
        ]);
        await fc.setFiles(coverFile);
        console.log('自定义封面已提交（UI filechooser 路径）:', path.basename(args.cover));
      } catch (e) {
        fc = null;
        if (attempt === 0) { console.log('filechooser 未触发，重定位入口后重试一次…'); continue; }
        throw new Error('「上传封面」两次点击均未弹 filechooser。input 直塞回退已废除（绕过 UI 时 cropper 不出现）。请人工上传封面，勿再驱动本页。');
      }
    }
    if (!fc) throw new Error('封面未能提交');
    // 3.5b) cropper 弹窗确认按钮：轮询 30s，只认 BUTTON（div/span 同名文本可能是页内其他元素）
    let done = null;
    for (let i = 0; i < 15 && !done; i++) {
      await sleep(2000);
      done = await p.evaluate(() => {
        // 2026-10-14 补修（09-23 已记录该改版但一直没落地）：确认按钮文案在 完成/Done 之间摇摆过，
        // 当时只找「完成」连 4 次 FATAL。此处四种文案全兼容，且只认 BUTTON。
        const btns = [...document.querySelectorAll('button')].filter((x) => /^(完成|Done|确定|保存)$/i.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0);
        if (!btns.length) return null;
        const el = btns[0];
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, cls: String(el.className).slice(0, 40) };
      });
    }
    if (!done) throw new Error('cropper 弹窗 30s 内未出现确认按钮（BUTTON 完成/Done/确定/保存）——封面未提交，请人工处理，勿再驱动本页');
    const clickable = await p.evaluate((pt) => { const t = document.elementFromPoint(pt.x, pt.y); return t ? t.tagName : 'none'; }, done);
    if (clickable === 'none') throw new Error('确认按钮坐标不可点（弹窗可能已关闭），请人工核对');
    await p.mouse.click(done.x, done.y);
    console.log('cropper 确认已点（' + done.cls + '）');
    await sleep(4000);
    // 3.5c) 验证：主封面缩略图为 3:4 比例（ratio≈0.75）且为新上传图（懒加载完成后取值）
    let verified = false;
    for (let i = 0; i < 8 && !verified; i++) {
      await sleep(1500);
      verified = await p.evaluate(() => {
        const img = [...document.querySelectorAll('img')].map((i) => ({ i, w: Math.round(i.getBoundingClientRect().width) })).filter((x) => /sinaimg/.test(x.i.src) && x.w > 100 && x.w < 200)[0];
        return !!(img && img.i.naturalHeight && Math.abs(img.i.naturalWidth / img.i.naturalHeight - 0.75) < 0.1);
      });
    }
    console.log(verified ? '封面已用竖版自定义图落表单 ✓' : '警告：封面比例验证未通过，请人工核对截图');
  }
  // 4) 截图，停「发送」前
  await p.screenshot({ path: SHOT });
  console.log('screenshot →', SHOT);
  console.log('STATUS: 已停在「发送」按钮前，等待用户点击发送（发送前请确认缩略图为视频模式）');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); if (process.env.WB_DEBUG_STACK) console.error(e.stack); process.exit(1); });
