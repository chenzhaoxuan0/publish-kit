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

  // 1) 点「图片」按钮 → 拦截 filechooser 传多图（坑位②：不能直塞隐藏 input）
  const btn = await p.evaluate(() => {
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
  if (!btn) throw new Error('未找到「图片」工具按钮（页面改版？）');
  console.log('「图片」按钮:', JSON.stringify(btn));
  const [chooser] = await Promise.all([
    p.waitForEvent('filechooser', { timeout: 10000 }),
    p.mouse.click(btn.x, btn.y),
  ]);
  await chooser.setFiles(imgs);
  console.log(`已通过 filechooser 提交 ${count} 张图（multiple=${chooser.isMultiple()}），等待九宫格渲染…`);

  // 2) 等九宫格缩略图落表单：正面证据 = composer 区内出现 ≥count 个 <img> 且 src 非空
  let gridOk = false;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const st = await p.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter((x) => (x.currentSrc || x.src || '').length > 0);
      // 九宫格缩略图特征：尺寸较小（<200px）且在页面上半部
      const thumbs = imgs.filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.width <= 200 && r.height > 0 && r.height <= 200; });
      return { total: imgs.length, thumbs: thumbs.length };
    }).catch(() => null);
    if (!st) continue;
    console.log(`  t+${(i + 1) * 3}s img=${st.total} 缩略图=${st.thumbs}`);
    if (st.thumbs >= count) { gridOk = true; break; }
  }
  if (!gridOk) throw new Error('九宫格缩略图未在 60s 内落表单，请人工查看页面');
  console.log('九宫格已渲染 ✓');

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
      if (opt) { await p.mouse.click(opt.x, opt.y); await sleep(2200); console.log('内容声明已选「内容由AI生成」✓'); }
      else { console.log('未找到「内容由AI生成」选项（面板可能改版），请人工核对'); }
    } else console.log('未找到内容声明触发器（span.woo-pop-ctrl），请人工核对');
  } else {
    console.log('publish.declare_ai = false，跳过内容声明（如实图内容请保持这样；AI 图卡会被平台拦）');
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
  process.exit(0);
})();
