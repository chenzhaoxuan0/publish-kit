// platforms/douyin.cjs — 抖音图文/视频发布填单脚本（patchright + CDP 连接外部 Chrome）
//
// ── 用途 ────────────────────────────────────────────────────────────
// 把已经生成好的图文/视频物料（图片目录、mp4、标题、描述 txt）填进抖音创作者后台的
// 发布表单：开页、切图文/视频 tab、传素材、填标题与描述、选话题、设双封面、设合集与
// 自主声明，最后截图留档并停在「发布」按钮前。
//
// ── 用法（在 publish-kit 目录下执行）─────────────────────────────────
//   node platforms/douyin.cjs open [--kind image|video]
//       新开标签页打开创作者上传页、切到对应 tab、写 dyKind 标。
//   node platforms/douyin.cjs upload --media <dir> [--count 7]
//       上传图片（img-01.png 起连续命名，--count 决定取几张）。
//   node platforms/douyin.cjs upload --kind video --file <mp4>
//       上传单个视频文件（>48MB 自动走 CDP 原生直传，见 lib/bigfile-upload.cjs）。
//   node platforms/douyin.cjs fill --title "..." --body-file <f.txt> [--kind image|video]
//       填标题 + 描述（含 # 话题逐个从联想面板选中）。
//   node platforms/douyin.cjs cover --kind video --vertical <3x4.png> [--horizontal <4x3.png>]
//       设置视频双封面（点槽位 →「上传封面」filechooser → 完成）。
//   node platforms/douyin.cjs collect [--kind image|video] [--album "<合集名>"]
//       选合集 + 自主声明「内容由AI生成」（2026-09-23 起经实测确定图文与视频都填）。
//   node platforms/douyin.cjs music [--kind image] [--music "<曲名>"]
//       选配乐（2026-10-22 起自动化，之前一直是人工选「收藏配乐 Opus 37」）。
//       走「收藏」tab → 按曲名精确匹配 → 点卡片上的「使用」。**仅图文线有配乐入口**。
//   node platforms/douyin.cjs shot [--kind image|video]
//       截图存档（publish.screenshot_dir 下 douyin-image.png / douyin-video.png）。
//
// ── 依赖处理方式 ────────────────────────────────────────────────────
//   1) patchright：走本包 node_modules（require('patchright')），未安装时本脚本直接报错退出，
//      并提示 npm install；不引用包外的任何绝对路径。
//   2) 浏览器：connectOverCDP 连一个已用 --remote-debugging-port 启动的 Chrome，
//      地址取 config.yaml 的 runtime.cdp_url（也可用环境变量 CDP_URL 临时覆盖）。
//      登录态由那个 Chrome profile 负责，本脚本不碰、不创建、不迁移任何浏览器 profile。
//   3) lib/config.cjs：所有「业务默认值」的唯一来源。留空 = 跳过该字段 + 控制台告警，
//      脚本永远不猜一个值替你填上（见 lib/config.cjs 顶部的契约说明）。
//
// ── 契约（最重要的一条）──────────────────────────────────────────────
//   本脚本只做填单，绝不点击「发布」，发布由用户本人完成。
//   另有一条交割护栏：标题已填的表单视为已交割给用户，拒绝重填（确需重填加 --force）。
//
//   本工具不对特定平台做自动化；是否接入某平台由使用者自行判断并承担后果。
//
// ── 多 tab 契约（2026-09-16 晚，经实测确定）──────────────────────────
//   图文与视频各占一个独立标签页，可任意先后并行填单。
//   kind 判别 = URL 精确特征（…/post/video、…/post/image）优先，否则读该页 sessionStorage 的
//   dyKind 标（open 时由本脚本写入；刷新保留、关页即清）。抖音点「发布图文/发布视频」tab 后
//   URL 仍停在 /content/upload（SPA 页内切换），URL 无法区分 kind，故必须靠 dyKind 标。
//   open 发现同 kind 表单页已存在时跳过导航（表单内容只在页面内存里，导航即丢——防重跑毁单），
//   也绝不触碰另一 kind 的表单页。
//   每步结尾截图并 process.exit(0)。
//
// ── 平台硬限制（这是平台规则，不是本工具的可调默认值）────────────────
//   标题 10-30 字（20 最佳）；图片 1-12 张、3:4；图文正文 ≤2000 字；话题 1-5 个；封面默认首图。
//   2026-10-06 简介降档：抖音简介（图文描述与视频简介同口径）上限由 1000 降为 900（视频简介实测
//   1000 顶格截断），dy-body 一律按 ≤900 生成（上游生成侧有对应守卫），填单侧不再放行超限文本。
//   标题 20 字符、正文 900 字这类数字来自平台侧限制，不是可以随手改的默认值——上游物料
//   要按这个口径生成，本脚本只做告警不做截断。
//
// ── 视频通道（2026-09-15，经实测打通）───────────────────────────────
//   默认落在「发布视频」标签；视频 file input 单文件隐藏，accept 含 video；
//   视频封面 cover 子命令（2026-09-21 打通，双封面版式）：点竖/横封面槽 → 编辑器（顶部标题
//   「设置竖封面/设置横封面」即当前模式）→ 传图必须选 class 链含 selectArea/upload- 的 input
//   （input[0]/[1] 是 AI 参考图口，传错会把图发进参考区）→ 等约 6s（封面检测在后台，文本
//   不必然出现）→ 点「完成」（button.semi-button）→ 引导弹窗「设置横封面获更多流量」点
//   「暂不设置」→ 验证两槽 img naturalWidth/naturalHeight 比例 ≈0.75 / ≈1.33。
//   2026-09-15 旧失败（保存后不落表单）根因 = 单槽旧版式 + 保存时序；新双槽版式按上述路径已实测落表单。
//   坑位清单：本文件里所有「实测/踩坑/回退」注释就是坑位清单本身——改选择器前先通读它们。
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config.cjs');
const { setVideoFile } = require('../lib/bigfile-upload.cjs');
// 2026-10-26 内化：截图留档层——截图失败只告警，不参与成败判据
const { shot } = require('../lib/shot.cjs');

let chromium;
try {
  chromium = require('patchright').chromium;
} catch {
  console.error('\n✗ patchright 未安装。在 publish-kit 目录下跑：npm install\n');
  process.exit(1);
}

const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1], i++;
    else out._.push(argv[i]);
  }
  return out;
}

// 合集名解析：命令行 --album 优先，未传则读 config.yaml 的 platforms.douyin.album。
// 两处都没有 → 留空（跳过该字段 + 告警），绝不猜一个值填上去。
function resolveAlbum(args) {
  return ('album' in args ? args.album : cfg.hint('douyin', 'album')) || '';
}

// ── 抖音图文「配乐」选择（2026-10-22）────────────────────────────────────
// 地面真相与坑位说明见下方 `music` 子命令的注释块。
// 返回 true = 已确认生效；false = 没生效（调用方只告警，不打断整条发布线）。

/** 扩展信息区配乐行读数（「修改音乐」只在已应用时出现） */
function readMusicRow(page) {
  return page
    .evaluate(() => {
      let best = null;
      for (const el of document.querySelectorAll('div,span')) {
        const t = el.innerText || '';
        if (!t) continue;
        if (!t.includes('修改音乐') && !t.includes('选择音乐')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height > 200) continue;
        if (!best || t.length < best.text.length) best = { text: t };
      }
      return {
        text: best ? best.text : '',
        applied: (document.body.innerText || '').includes('修改音乐'),
      };
    })
    .catch(() => ({ text: '', applied: false }));
}

/** 关掉音乐抽屉（失败路径也必须调 —— 开着会挡住合集下拉） */
async function closeMusicPanel(page) {
  const isOpen = () =>
    page
      .evaluate(() => {
        const el = document.querySelector('[class*="music-side-sheet"]');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 50 && r.height > 50;
      })
      .catch(() => false);
  if (!(await isOpen())) return;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  if (!(await isOpen())) return;
  const mask = await page
    .evaluate(() => {
      const sheet = document.querySelector('[class*="music-side-sheet"]');
      if (!sheet) return null;
      const r = sheet.getBoundingClientRect();
      return { x: Math.max(20, Math.round(r.x / 2)), y: Math.round(window.innerHeight / 2) };
    })
    .catch(() => null);
  if (mask) {
    await page.mouse.click(mask.x, mask.y);
    await page.waitForTimeout(900);
  }
}

/**
 * 找曲名（精确匹配）+ **同行「使用」按钮**。
 * ⚠️ 2026-10-22 实测教训：曾另写一份 findUseButton（逻辑看着一样）在真机上**恒返回 null**，
 *   而这一份 findSong 同时返回「曲名坐标」和「同行按钮」，探针逐值验证有效
 *   （hover 曲名 → 按钮从零尺寸展开成 52×32，与曲名中心 y 差 9px）。
 *   → **只保留一个实现**，避免两份逻辑漂移。
 */
function findSong(page, name) {
  return page
    .evaluate((nm) => {
      const sheet = document.querySelector('[class*="music-side-sheet"]');
      if (!sheet) return null;
      const hit = [...sheet.querySelectorAll('[class*="song-name"], [class*="song_name"]')].find(
        (n) => (n.textContent || '').trim() === nm
      );
      if (!hit) return null;
      const hr = hit.getBoundingClientRect();
      const nameCenterY = hr.y + hr.height / 2;
      let use = null;
      for (const b of sheet.querySelectorAll('button')) {
        const txt = (b.textContent || '').trim();
        if (!/使用/.test(txt)) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue; // 零尺寸 = 还没 hover 展开
        if (Math.abs(r.y + r.height / 2 - nameCenterY) > 30) continue;
        use = { x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
        break;
      }
      return { nameX: hr.x + hr.width / 2, nameY: nameCenterY, useButton: use };
    }, name)
    .catch(() => null);
}

/** 把曲名拉回视口（乱滚会把它推出视口，见坑位⑥） */
function scrollSongIntoView(page, name) {
  return page
    .evaluate((nm) => {
      const sheet = document.querySelector('[class*="music-side-sheet"]');
      if (!sheet) return null;
      const hit = [...sheet.querySelectorAll('[class*="song-name"], [class*="song_name"]')].find(
        (n) => (n.textContent || '').trim() === nm
      );
      if (!hit) return null;
      const vh = window.innerHeight;
      const targetY = Math.round(vh * 0.25);
      const cur = hit.getBoundingClientRect().top;
      if (cur >= 0 && cur <= vh - 40) return { already: true };
      let el = hit;
      let guard = 0;
      while (el && el !== sheet && guard++ < 14) {
        if (el.scrollHeight > el.clientHeight + 10 && el.clientHeight > 100) {
          el.scrollTop += cur - targetY;
          return { scrolled: true };
        }
        el = el.parentElement;
      }
      return { scrolled: false };
    }, name)
    .catch(() => null);
}

/** 找「使用」按钮（**同行判定**：与曲名同一行、文本含「使用」——探针实测唯一跑通的判定） */
function findUseButton(page, name) {
  return findSong(page, name).then((s) => (s ? s.useButton : null));
}

async function selectMusic(page, name, tab = '收藏') {
  try {
    // ① 入口（点 action 那个，不是行标题）
    const entry = await page.evaluate(() => {
      const cands = [];
      for (const el of document.querySelectorAll('span[class*="action"],button,a')) {
        const t = (el.textContent || '').trim();
        if (t !== '选择音乐' && t !== '添加音乐') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        cands.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, area: r.width * r.height });
      }
      cands.sort((a, b) => a.area - b.area);
      return cands[0] || null;
    });
    if (!entry) {
      console.warn('⚠ 未找到「选择音乐」入口 —— 配乐未设置');
      return false;
    }
    await page.mouse.click(entry.x, entry.y);
    await page.waitForTimeout(2000);

    // ② 切「收藏」tab（可能在横向滚动区里 → 先 scrollIntoView）
    const tabPos = await page.evaluate((lb) => {
      const hit = [...document.querySelectorAll('.semi-tabs-tab, [class*="semi-tabs-tab"]')].find(
        (t) => (t.textContent || '').trim() === lb
      );
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center', inline: 'center' });
      const r = hit.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, tab);
    if (!tabPos) {
      console.warn('⚠ 音乐面板里没找到「' + tab + '」tab —— 配乐未设置');
      return false;
    }
    await page.mouse.click(tabPos.x, tabPos.y);
    await page.waitForTimeout(2500);

    // ③ 找曲名
    let song = null;
    for (let i = 0; i < 10 && !song; i++) {
      song = await findSong(page, name);
      if (!song) await page.waitForTimeout(600);
    }
    if (!song) {
      console.warn('⚠ 收藏里没找到配乐「' + name + '」—— 配乐未设置');
      return false;
    }

    // ④ 拉回视口 → hover → 找「使用」按钮
    let useBtn = null;
    for (let attempt = 1; attempt <= 4 && !useBtn; attempt++) {
      const sc = await scrollSongIntoView(page, name);
      if (sc && sc.scrolled) await page.waitForTimeout(700);
      const s = await findSong(page, name);
      if (s && s.nameX) {
        // ⚠️ **只 hover 曲名本身**（探针实测：hover 曲名 → 「使用」按钮从零尺寸展开成 52×32）。
        //    ⛔ 不要把鼠标移到别处 —— 移开就失去 hover，按钮又缩回零尺寸。
        await page.mouse.move(s.nameX, s.nameY);
        await page.waitForTimeout(900);
      }
      useBtn = await findUseButton(page, name);
      if (!useBtn) continue;
    }
    if (!useBtn) {
      console.warn('⚠ 找不到配乐「' + name + '」的「使用」按钮 —— 配乐未设置');
      return false;
    }

    // ⑤ 点「使用」（点后抽屉自动关闭、配乐立即生效）
    await page.mouse.click(useBtn.x, useBtn.y);
    await page.waitForTimeout(2500);

    // ⑥ 校验读数
    for (let i = 0; i < 8; i++) {
      const st = await readMusicRow(page);
      if (st.applied && st.text.includes(name)) {
        console.log('配乐已选: ' + name + ' ✓（扩展信息区读数确认）');
        return true;
      }
      await page.waitForTimeout(600);
    }
    console.warn('⚠ 点了「使用」但扩展信息区读数没变成「' + name + '」—— 请人工核对');
    return false;
  } finally {
    // 无论成功失败都要关抽屉
    await closeMusicPanel(page);
  }
}

// 判别一个标签页属于哪个 kind：URL 精确特征优先，其次读 open 时写入的 dyKind 标。
// 2026-09-28 修复：dyKind 是 sessionStorage 标，同 tab 导航（如发布后跳 content/manage）不会清掉，
// 曾把 manage 列表页误判成 image 表单页导致 open 跳过导航——现仅 /content/upload 表单页允许用标判别
async function kindOf(page) {
  const url = page.url();
  if (/creator-micro\/content\/post\/video/.test(url)) return 'video';
  if (/creator-micro\/content\/post\/image/.test(url)) return 'image';
  if (/creator-micro\/content\/upload/.test(url)) {
    return await page.evaluate(() => sessionStorage.getItem('dyKind') || '').catch(() => '');
  }
  return '';
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'open';
  const kind = args.kind || 'image';
  if (kind !== 'image' && kind !== 'video') throw new Error('未知 --kind: ' + kind + '（可选 image|video）');
  // 每平台独立日志 + 步骤耗时表（2026-10-22 内化）
  // 用途：慢在哪不该靠猜。日志是**旁路**，不改变原有 console 输出行为。
  const { create } = require('../lib/log.cjs');
  const log = create({ platform: 'douyin', kind });
  // 截图统一落 config.yaml 的 publish.screenshot_dir（默认 ./screenshots），目录不存在即建
  const SHOT = path.join(cfg.screenshotDir(), kind === 'video' ? 'douyin-video.png' : 'douyin-image.png');
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  // ⚠️ 2026-10-22 内化（content 工作区 ego 通道实测）：**体检必须在起浏览器之前**。
  //   「上传后确认成功」的判据只能证明**页面上的东西**，证明不了**喂进去的东西**。
  //   真实事故：某平台的 images 只列了 1 张 → count=1 → 各平台只传了 1 张图，
  //   而每个平台的判据都「通过」了（1 ≥ 1 恒成立）→ 脚本报成功，结果全是残缺图集。
  //   → 起浏览器前就核对「声明要传几张」vs「目录里真有几张」，不过就不执行。
  //   （原来这条检查排在 connectOverCDP **之后** —— 起完浏览器才检查，等于白检查。）
  if (kind === 'image' && args.media && args.count) {
    const preCount = parseInt(args.count, 10);
    const preMedia = path.resolve(args.media);
    const pre = require('../lib/preflight.cjs').preflight({
      platform: 'douyin',
      mediaDir: preMedia,
      declaredCount: preCount,
      limits: { titleMax: 30 },
    });
    if (pre.warn && pre.warn.length) console.warn(`[preflight:douyin] ${pre.warn.length} 条提醒`);
  }
  const browser = await chromium.connectOverCDP(process.env.CDP_URL || cfg.cdpUrl(), { timeout: 15000 });
  const ctx = browser.contexts()[0];

  let page = null;
  for (const cand of ctx.pages()) {
    if ((await kindOf(cand)) === kind) { page = cand; break; }
  }

  if (cmd === 'open') {
    if (page) {
      console.log('已存在 ' + kind + ' 表单页，跳过导航以保护已填内容: ' + page.url().slice(0, 90));
    } else {
      page = await ctx.newPage();
      await page.goto(UPLOAD_URL, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(6000);
      try {
        const session = await ctx.newCDPSession(page);
        const { windowId } = await session.send('Browser.getWindowForTarget');
        // 2026-09-28：弃用 maximize——最大化后渲染面可能不同步（页面缩成一角、截图超时、元素点击
        // 全部落空），固定 normal + 1600×1000 强制重设渲染面
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await session.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1600, height: 1000 } });
        await page.waitForTimeout(1000);
      } catch (e) { console.warn('window size skip:', e.message); }
      if (kind === 'image') {
        // 上传页默认可能落在视频，切「发布图文」（JS 点击绕视口）
        const clicked = await page.evaluate(() => {
          const els = [...document.querySelectorAll('div,span,a,button')];
          const el = els.find((e) => /^上传图文$|^图文$|^发布图文$/.test(e.textContent.trim()) && e.children.length === 0);
          if (el) { el.click(); return true; }
          return false;
        });
        console.log('图文 tab clicked:', clicked);
      } else {
        // 视频通道：默认即「发布视频」；若之前停在图文则切回
        const clicked = await page.evaluate(() => {
          const els = [...document.querySelectorAll('div,span,a,button')];
          const el = els.find((e) => /^发布视频$|^上传视频$|^视频$/.test(e.textContent.trim()) && e.children.length === 0);
          if (el) { el.click(); return true; }
          return false;
        });
        console.log('视频 tab clicked:', clicked);
      }
      // 打 kind 标：URL 停在 /content/upload 不含 kind 特征，后续命令靠它找页（刷新保留）
      await page.evaluate((k) => sessionStorage.setItem('dyKind', k), kind).catch(() => {});
      await page.waitForTimeout(3000);
    }
  } else {
    if (!page) throw new Error('未找到 ' + kind + ' 表单页：先跑 node platforms/douyin.cjs open --kind ' + kind);
  }

  if (cmd === 'upload') {
    if (kind === 'video') {
      const file = path.resolve(args.file || '');
      if (!file || !fs.existsSync(file)) throw new Error('视频文件缺失: ' + file);
      await setVideoFile(page, 'input[type=file][accept*="video"]', file);
      console.log('已提交视频文件，等待上传与转码…');
      log.step('上传视频', path.basename(file));
      // 等待转码出标题/发布表单：视频进度条消失或出现封面预览，超时兜底再等
      await page.waitForTimeout(30000);
      log.step('视频上传 + 转码等待', '30s 固定等待');
    } else {
      const media = path.resolve(args.media || '.');
      const count = parseInt(args.count || '7', 10);
      const imgs = Array.from({ length: count }, (_, i) => path.join(media, `img-${String(i + 1).padStart(2, '0')}.png`));
      imgs.forEach((f) => { if (!fs.existsSync(f)) throw new Error(`图片缺失: ${f}`); });
      // ⚠️ 2026-10-22 实测修正（content 工作区 ego 通道实测，本轮内化）：
      //   ① **批量多选不可靠** —— 同一份代码同一个环境，给 6 张的结果在
      //      6/6、1/6、0/6 之间跳（连测 8 次）。**单张上传是稳定的** → 改成逐张传，
      //      每张传完等这一张的缩略图真的落位再传下一张。慢几秒，换确定性。
      //   ② **「已添加 N 张图片」这个文字计数不可信** —— 它统计的是**上传队列**，
      //      会在缩略图还没渲染落位时就显示 N。实测：文字说 6、截图只有 1 张、
      //      几秒后 DOM 里 6 张都在。判据必须**数实际渲染出来的缩略图**。
      //   ③ 缩略图是**延迟渲染**的 → 收尾要等实际缩略图数 == count 再截图。
      //      数法：从「继续添加」按钮往上找含图的父容器，数其中 w>20 && h>20 的 <img>。
      const countRendered = () =>
        page.evaluate(() => {
          // 定位「继续添加」按钮，它所在的含图容器就是图集区
          let anchor = null;
          for (const el of document.querySelectorAll('button,div[role=button],a,span')) {
            if ((el.textContent || '').trim() === '继续添加') { anchor = el; break; }
          }
          let scope = anchor;
          for (let i = 0; i < 8 && scope; i++) {
            const imgs = [...scope.querySelectorAll('img')].filter((im) => {
              const r = im.getBoundingClientRect();
              return r.width > 20 && r.height > 20;
            });
            if (imgs.length) return imgs.length;
            scope = scope.parentElement;
          }
          // 退化：全页里数大尺寸图（抖音首页没有别的 98×98 干扰，比微博安全）
          return [...document.querySelectorAll('img')].filter((im) => {
            const r = im.getBoundingClientRect();
            return r.width > 20 && r.height > 20;
          }).length;
        });
      // 逐张传（单张是稳定的）
      let uploaded = 0;
      for (const f of imgs) {
        const ok = await (async () => {
          try {
            const input = await page.waitForSelector('input[type=file][accept*="image"]', { timeout: 8000, state: 'attached' });
            await input.setInputFiles([f]);
            return true;
          } catch (e) {
            // input 没挂载 → 点「点击上传」区走原生 filechooser
            // ⚠️ 2026-10-22 内化：**入口偶发唤不起文件选择器**（坐标与成功那轮完全一致，
            //   但 filechooser 就是不弹）—— 微博 / 抖音图文 / 抖音视频三个平台都踩过。
            //   → pickFileWithRetry：最多点 3 次，每次**重新取入口坐标**（页面重排后旧坐标会落空）。
            try {
              const { pickFileWithRetry } = require('../lib/wait.cjs');
              const chooser = await pickFileWithRetry(
                page,
                async () => {
                  const pos = await page.evaluate(() => {
                    const el = [...document.querySelectorAll('div,span,label')].find((x) => {
                      const t = (x.textContent || '').trim();
                      return /点击上传/.test(t) && /图片/.test(t) && x.children.length === 0;
                    });
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    if (r.width < 5) return null;
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                  });
                  return pos;
                },
                { attempts: 3, timeout: 15000, step: 'douyin' }
              );
              await chooser.setFiles([f]);
              return true;
            } catch (e2) {
              console.warn('第 ' + (uploaded + 1) + ' 张没传上：' + e2.message);
              return false;
            }
          }
        })();
        if (ok) uploaded++;
        // 等这一张落位（缩略图延迟渲染）
        await sleep(1500);
        console.log(`已添加 ${uploaded}/${count} 张`);
      }
      // 收尾：等实际缩略图数 == count（不信文字计数）
      const deadline = Date.now() + 25000;
      let rendered = await countRendered();
      while (rendered < count && Date.now() < deadline) {
        await sleep(1000);
        rendered = await countRendered();
      }
      if (rendered < count) {
        console.warn(`⚠ 抖音只显示了 ${rendered}/${count} 张缩略图（按实际渲染数）—— 请人工核对`);
        log.warn(`图集只渲染出 ${rendered}/${count} 张`);
      } else {
        console.log(`图集复核：${rendered}/${count} 张 ✓（按实际渲染数）`);
        log.step('图集复核', `${rendered}/${count} 张（按实际渲染数）`);
      }
    }
  }

  if (cmd === 'fill') {
    if (!args.title) throw new Error('缺 --title');
    if (!args['body-file'] || !fs.existsSync(args['body-file'])) throw new Error('缺 --body-file');
    const body = fs.readFileSync(path.resolve(args['body-file']), 'utf-8').trim();
    const tlen = [...args.title].length;
    // 10-30 字是平台建议区间（20 最佳），超界只告警不截断——截断权归上游物料生成
    if (tlen < 10 || tlen > 30) console.warn(`[标题] ${tlen} 字符，抖音建议 10-30（20 最佳）`);
    // 标题（独立输入框，可能 placeholder 含"标题"）
    let title = await page.$('input[placeholder*="标题"]');
    if (!title) title = await page.$('input[maxlength="30"]');
    if (title) {
      // 交割护栏：标题已填（疑似已交割给用户）即拒绝重填
      const cur = await title.inputValue().catch(() => '');
      if (cur.trim() && !process.argv.includes('--force')) throw new Error('[交割护栏] 抖音' + (kind === 'video' ? '视频' : '图文') + '表单已填写（疑似已交割给用户），拒绝重复填单。确认需重填：加 --force 重跑。');
      await title.fill(args.title); console.log('标题已填');
    }
    else console.warn('未找到独立标题框，标题并入描述首行');
    // 描述编辑器：正文键盘输入 + 逐 tag 话题联想选中（2026-09-22 起）
    // 抖音话题也必须从联想面板选（.tag-hash-view-name 精确名匹配；无精确匹配时取大小写
    // 不敏感变体中浏览量最高者——低浏览量 tag 大概率是选错字眼/大小写；仍无则保留纯文本不回删）
    let editor = await page.$('.ql-editor, [contenteditable="true"]');
    if (!editor) editor = await page.$('textarea[placeholder*="描述"], textarea[placeholder*="标题"]');
    if (!editor) throw new Error('未找到描述编辑器');
    // 2026-09-28：「发文助手」浮窗（转码完成后弹出）会拦截编辑器点击——先整体隐藏
    await page.evaluate(() => document.querySelectorAll('[class*="creator-help"]').forEach((el) => { el.style.display = 'none'; }));
    if (process.argv.includes('--force')) {
      // --force 重填前清空编辑器（keyboard.type 是追加式，不清空会叠成超长/混入旧文；09-24/09-28 两度踩）
      await editor.click().catch(() => {});
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(400);
      console.log('编辑器已清空（--force）');
    }
    const bodyNorm = body.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n');
    const main = bodyNorm.split('\n#')[0];
    // 物料守卫：正文文件里出现 undefined/NaN 即 FATAL（2026-09-28 生成 bug 曾外溢到线上内容）
    if (/undefined|NaN|\[object Object\]/.test(main)) throw new Error('[物料守卫] body-file 含 undefined/NaN，疑似上游生成 bug：先修文件再填单');
    const topicTags = (bodyNorm.match(/#[^\s#]+/g) || []).map((x) => x.slice(1));
    await editor.click();
    await page.waitForTimeout(500);
    // ⚠️ 2026-10-22 内化提速（content 工作区 ego 通道实测）：
    //   逐字 keyboard.type 每敲一个字符都是一次 CDP 往返，N 个字符 = N 次往返。
    //   实测 958 字：逐块 type 要 12s，insertText 约 0.6s，**省约 11s**。
    //   ⚠️ insertText 不保证触发编辑器的 input 事件 → **必须回读校验**，
    //      对不上要**自动退回**逐块输入，不能把半截正文交割出去。
    //      （lib/wait.cjs 的 fillLongText 就是这个语义：insertText → 回读 → 退回逐块）
    const bodyText = title ? main : `${args.title}\n${main}`;
    const { fillLongText } = require('../lib/wait.cjs');
    const usedFast = await fillLongText(
      page,
      async () =>
        page.evaluate(() => {
          const e = document.querySelector('.ql-editor, [contenteditable="true"]');
          return e ? (e.innerText || e.textContent || '').trim().length : 0;
        }),
      bodyText,
      { step: 'douyin' }
    );
    console.log(usedFast ? '描述正文已填（一次性插入 + 回读校验通过）' : '描述正文已填（退回逐块输入）');
    log.step('描述正文', usedFast ? '一次性插入（insertText）' : '逐块输入（回退路径）');
    // 话题：**单轮 + 精确回删**（2026-10-22 重写）
    // ⚠️ 2026-10-22 实测报障（用户：「最后几个 tag 是混乱状态」）：
    //    10-21 期实测尾部是「#Anthropic #SpaceX #OpenAI #ChatGPT #v#AA大人AI日报人人工
    //    智能大模型AAILLLM」——前 4 个是干净 chip，后面全是交织碎片。
    //    上一版的「两轮法」（探测轮 → 正式轮 → 纯文本接尾）**实测彻底失败**：
    //    探测轮 10 个词全部 0 候选，接尾阶段把正文搅成字符交织的乱码。
    //    根因经真机探针定位为**两条**：
    //      a) 抖音的联想面板**永远把你输入的词回显成一个候选（浏览量 0）** ——
    //         抖音话题库里没有这个词时，面板照样显示「#ZZZ不存在话题 0」。
    //         只按「精确名匹配」判 → 把 count=0 的假候选当真 → 点下去不落 chip，
    //         而且假候选留在编辑器里会成为后续前缀替换的引子。
    //         → 判据必须是 **精确名命中 且 浏览量 > 0**。
    //      b) 用 selectAllChildren+collapseToEnd 挪光标会**破坏编辑器 selection 状态**
    //         （抖音编辑器是 Ace 系：ace-line / data-leaf / data-string）——
    //         面板不弹、文本插错位置 → 表现为「0 候选 + 字符交织」。
    //         → 光标定位改用 **Control+End**（End 只到当前折行行尾，多行正文会插进中间）。
    //    现在的做法：逐词处理 → 有真实候选就点选落地 chip → 没有就**立刻精确回删**
    //    （Escape 关面板后纯文本可干净回删）→ 每步都校验 chip 数与正文长度，
    //    对不上就中止并告警，绝不交割乱稿。
    const TOPIC_MAX = 5;
    const readState = () => page.evaluate(() => {
      const ed = document.querySelector('.ql-editor, [contenteditable="true"]');
      const text = ed ? (ed.innerText || ed.textContent || '') : '';
      return {
        len: text.length,
        chips: document.querySelectorAll('[data-mention]').length,
        tail: text.slice(-300),
      };
    });
    const readCands = () => page.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const nm of document.querySelectorAll('[class*="tag-hash-view-name"]')) {
        const name = (nm.textContent || '').trim();
        if (!name) continue;
        let row = nm.parentElement;
        let guard = 0;
        while (row && !row.querySelector('[class*="tag-hash-view-count"]') && guard++ < 6) row = row.parentElement;
        if (!row || seen.has(row)) continue;
        const r = row.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        seen.add(row);
        const ct = row.querySelector('[class*="tag-hash-view-count"]');
        out.push({ name, countText: ct ? (ct.textContent || '').trim() : '0', x: r.x + r.width / 2, y: r.y + r.height / 2 });
      }
      return out;
    });
    const parseCount = (text) => {
      if (!text) return 0;
      const m = String(text).match(/([\d.]+)\s*([万亿]?)/);
      if (!m) return 0;
      const n = parseFloat(m[1]) || 0;
      if (m[2] === '万') return n * 1e4;
      if (m[2] === '亿') return n * 1e8;
      return n;
    };
    // 只认浏览量 > 0 的候选（count=0 是面板的回显假候选）
    const pickCand = (items, kw) => {
      const viable = items.filter((x) => parseCount(x.countText) > 0);
      if (!viable.length) return null;
      const exact = viable.find((x) => x.name === kw);
      if (exact) return exact;
      const ci = viable.filter((x) => x.name.toLowerCase() === kw.toLowerCase());
      if (!ci.length) return null;
      return ci.sort((a, b) => parseCount(b.countText) - parseCount(a.countText))[0];
    };
    // ⚠️ 2026-10-22 实测踩坑：抖音面板是**两段式 + 异步过滤**渲染 ——
    //   ① 立刻渲染一个「回显候选」（就是你刚输入的词，浏览量恒为 0）
    //   ② 远程候选列表稍后才回来（真候选浏览量 > 0）
    //   ③ 边打字边过滤：一次性打完整个词后，面板可能还在用**上一次的查询词**返回结果
    //   「面板出现了」不等于「候选列表到了且是当前的」→ 只等面板出现就读，
    //   每次都只读到 count=0 的回显 → 所有词误判成「话题库里没有」→ 一个 chip 都落不上。
    //   → 判据：**连续两轮读到相同的候选列表**（列表已稳定）才判定；超时取最后一次。
    const waitPanel = async () => {
      const deadline = Date.now() + 8000;
      let last = [];
      let lastKey = '';
      let stable = 0;
      while (Date.now() < deadline) {
        const items = await readCands();
        const key = items.map((x) => x.name + ':' + x.countText).join('|');
        if (key && key === lastKey) stable++; else stable = 0;
        lastKey = key;
        last = items;
        if (items.length && stable >= 2) return items;
        await page.waitForTimeout(300);
      }
      return last;
    };
    const pinToEnd = async () => {
      // ⚠️ 不用 selectAllChildren（会破坏 selection 状态）—— 用 Control+End
      await page.keyboard.press('Control+End');
      await page.waitForTimeout(150);
    };

    let topicState = await readState();
    const baseLen = topicState.len;
    const baseChips = topicState.chips;
    let linked = 0;
    const skippedTags = [];   // 抖音话题库里确实没有这个词
    const overLimitTags = []; // 填满上限才没轮到（与上面是两回事，日志要分开报）
    let topicGarbled = false;

    for (const kw of topicTags) {
      if (linked >= TOPIC_MAX) { overLimitTags.push(...topicTags.slice(topicTags.indexOf(kw))); break; }
      await pinToEnd();
      await page.waitForTimeout(200);
      const needSpace = !/[ \u00a0]$/.test(topicState.tail);
      const typed = (needSpace ? ' ' : '') + '#' + kw;
      const before = await readState();
      await page.keyboard.type(typed, { delay: 80 });
      await page.waitForTimeout(400);
      const items = await waitPanel();
      const hit = pickCand(items, kw);
      console.log(
        '话题「' + kw + '」面板返回 ' + items.length + ' 个候选: ' +
          (items.length ? items.slice(0, 6).map((x) => x.name + '(' + x.countText + ')').join(' / ') : '无') +
          (hit ? ' → 命中「' + hit.name + '」' : ' → 无精确匹配')
      );
      if (!hit) {
        // 抖音话题库里没有这个词 → 立刻精确回删（不留残字、不留开着的面板）
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        for (let i = 0; i < typed.length; i++) await page.keyboard.press('Backspace');
        await page.waitForTimeout(250);
        const after = await readState();
        if (after.len !== before.len || after.chips !== before.chips) {
          console.log('✗ 回删「' + kw + '」后正文对不上（长度 ' + before.len + '→' + after.len + '，chip ' + before.chips + '→' + after.chips + '）—— 停止填话题');
          topicGarbled = true;
          topicState = after;
          break;
        }
        skippedTags.push(kw);
        console.log('话题「' + kw + '」抖音话题库里没有（浏览量 0）→ 已回删跳过');
        topicState = after;
        continue;
      }
      await page.mouse.click(hit.x, hit.y);
      await page.waitForTimeout(1000);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      const after = await readState();
      if (after.chips !== before.chips + 1) {
        console.log('⚠ 点选「' + hit.name + '」没落成 chip（chip ' + before.chips + '→' + after.chips + '）→ 回删重试判定');
        await pinToEnd();
        for (let i = 0; i < typed.length + 2; i++) await page.keyboard.press('Backspace');
        await page.waitForTimeout(250);
        const fixed = await readState();
        if (fixed.chips !== before.chips) {
          console.log('✗ 点选失败后回删把已落地 chip 也啃掉了（chip ' + before.chips + '→' + fixed.chips + '）—— 停止填话题');
          topicGarbled = true;
          topicState = fixed;
          break;
        }
        skippedTags.push(kw);
        topicState = fixed;
        continue;
      }
      linked++;
      console.log('话题「' + kw + '」已点选落地（候选「' + hit.name + '」' + hit.countText + '）');
      await pinToEnd();
      topicState = after;
    }

    // 收尾：读回 + 碎片检测（一个 token 里出现第二个 # 就是碎片）
    topicState = await readState();
    const bad = topicState.tail.split(/\s+/).filter((t) => t.includes('#') && (t.match(/#/g) || []).length > 1);
    if (bad.length) {
      console.log('⚠ 描述尾部检测到疑似碎片：' + bad.slice(0, 3).join(' / ') + ' —— 请人工核对截图再发布');
      topicGarbled = true;
    }
    if (topicState.chips - baseChips !== linked) {
      console.log('⚠ 话题 chip 数与记录不一致（记录 ' + linked + '，DOM ' + (topicState.chips - baseChips) + '）—— 请人工核对');
      topicGarbled = true;
    }
    if (skippedTags.length) {
      console.log('话题跳过 ' + skippedTags.length + ' 个（抖音话题库无此话题）: ' + skippedTags.join('/'));
    }
    if (overLimitTags.length) {
      console.log('话题另有 ' + overLimitTags.length + ' 个未填（已达抖音上限 ' + TOPIC_MAX + ' 个，非「话题库没有」）: ' + overLimitTags.join('/'));
    }
    console.log('话题已落地 ' + linked + ' 个 chip（正文 ' + baseLen + ' → ' + topicState.len + ' 字）');
    log.step('话题', linked + ' 个 chip 落地' + (skippedTags.length ? '，跳过 ' + skippedTags.length : ''));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    console.log('描述已填写');
  }

  if (cmd === 'music') {
    // 抖音图文「配乐」：收藏 → 指定曲目 → 点「使用」
    // 2026-10-22 起自动化（之前一直是人工选「收藏配乐 Opus 37」）。
    //
    // ⚠️ **只有图文线有配乐入口**（视频线是视频自带音轨，没有这一步）。
    //    视频线误用要**立刻报错**，不能静默失败让人以为配上了。
    if (kind !== 'image') {
      throw new Error('music 子命令仅支持 --kind image（视频线是视频自带音轨，没有配乐入口）');
    }
    //
    // ── 地面真相（ego lite 真机探针实测，与 content 工作区 ego 通道同源）──
    //   ① 入口 = 扩展信息区「选择音乐」。⚠️ 页面上这文案出现**两次**：
    //      行标题（span.title-content-*）与右侧**动作按钮**（span.action-*）——
    //      点标题不生效，必须点 action 那个。
    //   ② 面板 = **右侧抽屉**（[class*="music-side-sheet"]），不是 modal。
    //   ③ 「收藏」tab = .semi-tabs-tab 文案**恰为**「收藏」；
    //      在 .semi-overflow-list 里（宽 332px）可能被横向滚动藏起来 → 先 scrollIntoView。
    //   ④ 曲目卡：曲名在 [class*="song-name"]（精确文本）；
    //      「使用」按钮 class 含 apply-btn-*，与曲名**同卡片并排**（不在曲名的祖先链上）
    //      → 从**按钮往上**回溯卡片曲名。
    //   ⑤ ⚠️ 「使用」按钮**零尺寸**（未 hover 时 rect=0×0）→ 不能按尺寸过滤；
    //      零尺寸时用**卡片右缘**反推位置。
    //   ⑥ ⚠️ 乱滚会把曲名推出视口（实测曲名 y=-127）→ 滚动要把曲名**拉回视口**。
    //   ⑦ ✅ 点「使用」后抽屉自动关闭、配乐立即生效；底部「确定」是 disabled，**不要点**。
    //   ⚠️ 失败时**必须关抽屉** —— 开着会挡住后面的合集下拉。
    const musicName = ('music' in args ? args.music : cfg.hint('douyin', 'music')) || '';
    if (!musicName) {
      cfg.warnSkipped('douyin', 'music', '抖音配乐');
    } else {
      const musicOk = await selectMusic(page, musicName);
      if (!musicOk) {
        console.warn('⚠ 配乐未自动设置 —— 请人工在发布页选「' + musicName + '」');
      }
    }
  }

  if (cmd === 'collect') {
    // 2026-09-23 起 --kind image 也支持（经实测确定：图文与视频都要填合集 + AI 声明）
    // 合集名来源：命令行 --album 优先，其次 config.yaml 的 platforms.douyin.album；
    // 都没有 → 不选择合集（留空 ≠ 报错退出，也 ≠ 猜一个值填上去），并统一告警一次，
    // 由用户在点发布前手选。显式传空 --album 可用于本次跳过。
    const album = resolveAlbum(args);
    if (!album) cfg.warnSkipped('douyin', 'album', '抖音合集');
    // 1) 合集：点「请选择合集」（视频页）/「不选择合集」（图文页）→ 下拉点选目标合集
    // 2026-09-30 修：图文页比视频页长（多封面/图片编辑区），合集区常在视口外
    // （实测 y=1002 vs 视口 907），坐标 mouse.click 落空 → 下拉未开 → 「选项未找到」
    // FATAL（三期三败，仅图文复现）。点击前 scrollIntoView 拉回视口。
    const csel = album ? await page.evaluate(() => {
      const el = [...document.querySelectorAll('.semi-select-selection-text')].find((x) => ['请选择合集', '不选择合集'].includes((x.textContent || '').trim()));
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }) : null;
    if (csel) {
      await page.mouse.click(csel.x, csel.y);
      await page.waitForTimeout(2500);
      const opt = await page.evaluate((name) => {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.textContent || '').trim();
          if (t === name && el.children.length === 0) {
            const r = el.getBoundingClientRect();
            if (r.width > 10) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      }, album);
      if (!opt) throw new Error('合集「' + album + '」选项未找到（平台未推荐该合集？）');
      await page.mouse.click(opt.x, opt.y);
      await page.waitForTimeout(2000);
      // 校验改全页文本（2026-09-30）：图文页合集选中后显示在输入框形态，不在
      // .semi-select-selection-text 里，旧校验假阴性报「状态异常」（实际已选上）
      const ok = await page.evaluate((name) => document.body.innerText.includes(name), album);
      console.log(ok ? '合集已选: ' + album + ' ✓' : '警告：合集状态异常，请人工核对');
    } else console.log(album ? '合集已设置过（未找到空下拉），跳过' : '合集：未配置，本次不选择');
    // 2) 自主声明：是否代填「内容由AI生成」由 config.yaml 的 platforms.douyin.self_declare 决定。
    //    未配置或为 false → 不代填（合规标注仍需用户自己在发布页选），统一告警一次。
    const selfDeclare = cfg.bool('douyin', 'self_declare');
    if (!selfDeclare) cfg.warnSkipped('douyin', 'self_declare', '抖音自主声明（内容由AI生成）');
    // 点「请选择自主声明」→ 弹窗选「内容由AI生成」→ 确定（同样先滚入视口）
    const dsel = selfDeclare ? await page.evaluate(() => {
      const el = [...document.querySelectorAll('[class*="selectText"]')].find((x) => (x.textContent || '').trim() === '请选择自主声明');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }) : null;
    if (dsel) {
      await page.mouse.click(dsel.x, dsel.y);
      await page.waitForTimeout(2000);
      const opt = await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          const t = (el.textContent || '').trim();
          if (t === '内容由AI生成' && el.children.length === 0) {
            const r = el.getBoundingClientRect();
            if (r.width > 5) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      });
      if (!opt) throw new Error('「内容由AI生成」声明选项未找到');
      await page.mouse.click(opt.x, opt.y);
      await page.waitForTimeout(1000);
      const det = await page.evaluate(() => {
        const el = [...document.querySelectorAll('button')].filter((x) => (x.textContent || '').trim() === '确定' && x.getBoundingClientRect().width > 0).pop();
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!det) throw new Error('声明弹窗「确定」按钮未找到');
      await page.mouse.click(det.x, det.y);
      await page.waitForTimeout(2000);
      const val = await page.evaluate(() => {
        const el = [...document.querySelectorAll('[class*="selectText"]')].find((x) => x.getBoundingClientRect().width > 0);
        return el ? (el.textContent || '').trim() : null;
      });
      console.log(val === '内容由AI生成' ? '自主声明: 内容由AI生成 ✓' : '警告：自主声明状态异常（' + val + '），请人工核对');
    } else console.log(selfDeclare ? '自主声明已设置过（未找到空下拉），跳过' : '自主声明：未配置 platforms.douyin.self_declare，本次不代填');
  }

  if (cmd === 'cover') {
    if (kind !== 'video') throw new Error('cover 子命令仅支持 --kind video');
    const targets = [];
    if (args.vertical) {
      if (!fs.existsSync(path.resolve(args.vertical))) throw new Error('竖封面文件缺失: ' + args.vertical);
      targets.push({ slot: '竖封面', file: path.resolve(args.vertical), label: '竖封面', want: '设置竖封面', minRatio: 0.7, maxRatio: 0.8 });
    }
    if (args.horizontal) {
      if (!fs.existsSync(path.resolve(args.horizontal))) throw new Error('横封面文件缺失: ' + args.horizontal);
      targets.push({ slot: '横封面', file: path.resolve(args.horizontal), label: '横封面', want: '设置横封面', minRatio: 1.25, maxRatio: 1.4 });
    }
    if (!targets.length) throw new Error('缺 --vertical / --horizontal 至少一项');
    // 硬验证的基准快照：**必须在上传之前**取。
    // 2026-10-19 修：原实现把快照取在上传循环之后，等于拿「已落上的自定义封面」
    // 和「已落上的自定义封面」比，src 必然相同 → 每次成功都误报「src 未变化」
    // 并抛 FATALexit 1。封面其实早就落上了，误报会把后续步骤打断、也可能诱发
    // 在已填页面上重跑 cover。
    const slotSrcByWord = (word) => page.evaluate((w) => {
      for (const el of document.querySelectorAll('[class*="coverControl"]')) {
        if ((el.textContent || '').includes(w)) { const img = el.querySelector('img'); return img ? (img.src || '') : ''; }
      }
      return null;
    }, word);
    const srcBefore = {};
    for (const t of targets) srcBefore[t.slot] = await slotSrcByWord(t.slot);
    for (const t of targets) {
      // 1) 点对应封面槽位打开编辑器（槽位 label「选择/编辑封面」均可点）
      //    槽位必须按文本「竖封面」/「横封面」定位，不能用 DOM 下标——2026-09-28 实测
      //    coverControl 的顺序是 [横封面4:3, 竖封面3:4]，按下标取会把竖图传进横编辑器。
      const slotBox = await page.evaluate((word) => {
        const el = [...document.querySelectorAll('[class*="coverControl"]')]
          .find((d) => (d.textContent || '').includes(word) && d.getBoundingClientRect().width > 0);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 60) };
      }, t.slot);
      if (!slotBox) throw new Error('封面槽位 ' + t.slot + ' 未找到');
      await page.mouse.click(slotBox.x, slotBox.y);
      await page.waitForTimeout(3000);
      // 2) 校验/切换编辑器模式（防把横图传进竖编辑器）
      //    ⚠️ 2026-10-22 修正（content 工作区 ego 通道实测）：
      //    原来判据是「`.dy-creator-content-modal` 里有没有标题文本恰为『设置竖封面』」。
      //    两个问题：
    //      a) **没步骤条 ≠ 错**。抖音在「某个封面已经设过」之后，再开另一个封面的
    //         编辑器是**单模式直传面板**（只有「上传封面 + 点击上传文件或拖拽文件到这里」，
    //         步骤条整个不渲染）→ 此时模式由「点的是哪个槽」决定，本来就必然对。
    //         旧实现在这里 `throw` → **整条视频线 FATAL 中止**（封面其实是对的）。
    //      b) 步骤条上「设置竖封面 / 设置横封面」是**两个 tab**，当前模式 =
    //         class 含 **`step-active`** 的那一个。页面上另有一个 BUTTON 文本也是
    //         「设置横封面」，但它带 `data-popupid` —— 那是**提示气泡触发器**，不是 tab。
    //    → 做法：读 step-active 判定当前模式，不对就**点目标 tab**，再复核；
    //      根本没有步骤条时**信任槽位**、告警后继续。
      const mode = await page.evaluate((want) => {
        const steps = [...document.querySelectorAll('div')].filter((e) => {
          const t = (e.textContent || '').trim();
          if (t !== '设置竖封面' && t !== '设置横封面') return false;
          const cls = e.className?.toString?.() || '';
          if (!cls.includes('step')) return false;
          return e.getBoundingClientRect().width > 0;
        });
        const active = steps.find((e) => (e.className?.toString?.() || '').includes('active'));
        const target = steps.find((e) => (e.textContent || '').trim() === want);
        const tr = target ? target.getBoundingClientRect() : null;
        return {
          hasSteps: steps.length > 0,
          activeText: active ? (active.textContent || '').trim() : '',
          targetFound: !!target,
          x: tr ? tr.x + tr.width / 2 : 0,
          y: tr ? tr.y + tr.height / 2 : 0,
        };
      }, t.want);
      if (!mode.hasSteps) {
        // 单模式直传面板 → 模式由所点槽位决定，本来就必然对 → 告警后继续，不 FATAL
        console.warn('封面编辑器没有步骤条（单模式直传面板）→ 模式由所点槽位「' + t.slot + '」决定，继续');
      } else if (mode.activeText !== t.want) {
        console.log('封面编辑器当前在「' + (mode.activeText || '未知') + '」模式 → 切到「' + t.want + '」');
        await page.mouse.click(mode.x, mode.y);
        await sleep(1500);
        const after = await page.evaluate((want) => {
          const steps = [...document.querySelectorAll('div')].filter((e) => {
            const t = (e.textContent || '').trim();
            if (t !== '设置竖封面' && t !== '设置横封面') return false;
            const cls = e.className?.toString?.() || '';
            if (!cls.includes('step')) return false;
            return e.getBoundingClientRect().width > 0;
          });
          const active = steps.find((e) => (e.className?.toString?.() || '').includes('active'));
          return { activeText: active ? (active.textContent || '').trim() : '' };
        }, t.want);
        if (after.activeText !== t.want) {
          throw new Error('封面编辑器未进入「' + t.want + '」模式（当前 ' + (after.activeText || '未知') + '），中止防错传（可能页面改版）。请人工在窗口里设' + t.slot + '。');
        }
      }
      // 3) 点编辑器内黑色「上传封面」按钮 → 原生 filechooser → setFiles
      //    （2026-09-22 修正：编辑器处于 AI封面模式，setInputFiles 塞 input 只会把图送进
      //    「生成参考图」列表，封面画布不变——必须走按钮的 filechooser 路径才真正上传）
      // ⚠️ 2026-10-22 内化：**入口偶发唤不起文件选择器**（三个平台都踩过）
      //   → pickFileWithRetry：最多点 3 次，每次**重新取「上传封面」按钮坐标**。
      const { pickFileWithRetry } = require('../lib/wait.cjs');
      const fc = await pickFileWithRetry(
        page,
        async () =>
          page.evaluate(() => {
            const modal = document.querySelector('.dy-creator-content-modal');
            const scope = modal || document;
            for (const el of scope.querySelectorAll('*')) {
              const t2 = (el.textContent || '').trim();
              if (t2 === '上传封面' && el.children.length <= 1) {
                const r = el.getBoundingClientRect();
                if (r.width > 20) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
            return null;
          }),
        { attempts: 3, timeout: 10000, step: 'douyin-cover' }
      );
      await fc.setFiles(t.file);
      console.log(t.label + ' 已通过 filechooser 提交: ' + path.basename(t.file));
      await page.waitForTimeout(4000);
      // 4) 点编辑器「完成」
      const done = await page.evaluate(() => {
        const modal = document.querySelector('.dy-creator-content-modal');
        const el = [...(modal ? modal.querySelectorAll('button') : [])].filter((x) => (x.textContent || '').trim() === '完成' && x.getBoundingClientRect().width > 0).pop();
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (!done) throw new Error('「完成」按钮未找到');
      await page.mouse.click(done.x, done.y);
      await page.waitForTimeout(3000);
      // 5) 「设置横封面获更多流量」引导弹窗 → 暂不设置
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('button, div, span')].find((x) => (x.textContent || '').trim() === '暂不设置' && x.getBoundingClientRect().width > 0);
        if (el) el.click();
      });
      await page.waitForTimeout(1500);
      console.log(t.label + ' 已完成');
    }
    // 6) 硬验证：槽位元素截图（视觉留档，人可复核；比例检查不可靠——默认帧裁剪比例恰好相同）。
    //    2026-10-08 加固：以「img.src 前后变化」为程序化判据（被替换成自定义图则 src 必变）——
    //    当日竖封面「已提交+已完成」输出齐全却静默回落默认帧，仅靠 slot 截图人工目检才暴露。
    //    srcBefore 已在上传前取好（见上），此处只取 after 比对。
    const slots = page.locator('[class*="coverControl"]');
    for (let i = 0; i < await slots.count(); i++) {
      await slots.nth(i).screenshot({ path: SHOT.replace('.png', '-slot' + i + '.png'), timeout: 15000 }).catch(() => {});
    }
    const srcFails = [];
    for (const t of targets) {
      const after = await slotSrcByWord(t.slot);
      const changed = !!after && after !== srcBefore[t.slot];
      if (!changed) srcFails.push(t.slot);
      console.log((changed ? '✓' : '✗') + ' ' + t.slot + ' src ' + (changed ? '已更新（自定义图落上，DOM 验证）' : '未变化'));
    }
    // src 未变化**不抛 FATAL**，只大声告警并指向槽位截图。
    // 2026-10-19 修：原实现无脑 throw，把「已落上的自定义封面」判成失败，
    // 打断流水线；更危险的是它会诱发在**已填好的发布页**上重跑 cover——
    // 那正是 10-18 期「视频重传」事故的形状。这里改成告警 + 留截图给人目检：
    // 封面最终以人为发布前的预览为准，守卫不该替你按停。
    if (srcFails.length) {
      console.log('⚠ 封面槽位 src 未变化：' + srcFails.join('/') + '。'
        + '两种可能：(a) 平台静默回落默认帧（真失败）；(b) 这张封面本来就已经是当前封面（重跑场景，src 不变是正常的）。'
        + '请目检槽位截图 ' + path.join(cfg.screenshotDir(), 'douyin-video-slot0.png') + ' / -slot1.png 确认，'
        + '**不要盲目重跑 cover**（已填页面重跑会污染表单）。');
    }
    console.log('槽位截图已存（' + path.join(cfg.screenshotDir(), 'douyin-video-slot0.png') + ' / -slot1.png），请目检封面内容');
  }

  // 2026-10-03 护栏：视频线收尾前查自主声明——当日执行按收窄指令漏跑 collect（合集+声明），
  // 直到发布时才发现声明缺失。此处读数异常立即大声告警，把问题拦在交割前
  // 2026-10-06 修：合集纳入同一护栏（当日合集同样漏设、需人工补），两项一起读数告警
  if (kind === 'video') {
    const album = resolveAlbum(args);
    const st = await page.evaluate((album) => {
      const decEl = [...document.querySelectorAll('[class*="selectText"]')].find((x) => x.getBoundingClientRect().width > 0);
      const albumSet = !!album && ([...document.querySelectorAll('.semi-select-selection-text')].some((x) => (x.textContent || '').includes(album))
        || document.body.innerText.includes(album));
      return { dec: decEl ? (decEl.textContent || '').trim() : null, albumSet };
    }, album).catch(() => null);
    if (st) {
      if (st.dec === '内容由AI生成') console.log('自主声明读数 ✓（内容由AI生成）');
      else console.log('警告：自主声明未设置（读数: ' + st.dec + '）——大概率漏跑 collect。补跑：node platforms/douyin.cjs collect --kind video，或发布前人工补选「内容由AI生成」');
      if (!album) console.log('合集读数跳过（platforms.douyin.album 未配置，无从核对）');
      else if (st.albumSet) console.log('合集读数 ✓（' + album + '）');
      else console.log('警告：合集「' + album + '」未设置——大概率漏跑 collect。补跑：node platforms/douyin.cjs collect --kind video --album "' + album + '"，或发布前人工选择合集');
    }
  }

  await shot(page, SHOT, { fullPage: false });
  console.log('screenshot →', SHOT);
  console.log('STATUS: 已停在发布按钮前，等待用户点击「发布」');
  log.finish('ok');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e.message);
  // 异常路径也要把日志收尾（耗时表 + 告警汇总），否则失败时反而没有留痕
  try {
    require('../lib/log.cjs')
      .create({ platform: 'douyin', kind: (() => { try { return parseArgs(process.argv.slice(2)).kind || 'image'; } catch (_) { return 'image'; } })() })
      .finish('failed');
  } catch (_) { /* 日志收尾失败不影响主流程 */ }
  process.exit(1);
});
