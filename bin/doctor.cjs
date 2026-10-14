#!/usr/bin/env node
// bin/doctor.cjs — 环境体检
//
// 解决的问题：原流程里「未登录」是被动触发的——跑到某个平台脚本报错才知道要去登录，
// 换一个平台再撞一次。doctor 把它变成主动的一次性体检。
//
// 顺带两件事：
//   1. 各平台原本各写一行登录正则（B站判 passport 域名 / 微博判 signin / 知乎判按钮在不在…），
//      这里收拢成一张表，既是体检用，也是各平台脚本的登录态判定事实源。
//   2. Chrome 路径探测。原先 launch 脚本把本机绝对路径写死了，别人 clone 下来起不来。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('../lib/config.cjs');
const platforms = require('../lib/platforms.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --no-launch：完全不碰浏览器 —— 既不拉起，也跳过逐平台登录态检查。+
// 登录态检查要逐个 goto 创作者后台，对正在用同一个 Chrome 的人是打扰，CI 里也无意义。
const NO_LAUNCH = process.argv.includes('--no-launch');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const ok = (s) => `${C.green}✓${C.reset} ${s}`;
const bad = (s) => `${C.red}✗${C.reset} ${s}`;
const warn = (s) => `${C.yellow}!${C.reset} ${s}`;
const skip = (s) => `${C.dim}—${C.reset} ${s}`;

// ── Chrome 路径探测 ───────────────────────────────────────
function chromeCandidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}

function detectChrome() {
  for (const p of chromeCandidates()) {
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

// ── CDP 在线探测 ──────────────────────────────────────────
async function cdpInfo(base) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const res = await fetch(`${base}/json/version`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 平台登录态判定表在 lib/platforms.cjs（doctor 与 login 共用；各平台脚本另有自己的预检）

function launchChrome(chromePath, profileDir, port) {
  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (process.platform === 'win32') {
    spawn(chromePath, args, { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(chromePath, args, { detached: true, stdio: 'ignore' }).unref();
  }
}

async function main() {
  console.log(`\n${C.bold}publish-kit 环境体检${C.reset}`);
  console.log('─'.repeat(60));

  const problems = [];
  const tips = [];

  // 0. 配置
  if (!cfg.exists()) {
    console.log(bad('config.yaml 不存在'));
    console.log(`\n  先跑一次初始化：  node bin/init.cjs\n`);
    process.exit(1);
  }
  const conf = cfg.load();
  console.log(ok(`config.yaml  ${C.dim}${path.relative(process.cwd(), conf.path)}${C.reset}`));
  console.log(`      内容领域：${cfg.contentDomain() || C.yellow + '(未填)' + C.reset}`);

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) { console.log(bad(`Node ${process.versions.node} 过低，需 >= 18`)); problems.push('node'); }
  else console.log(ok(`Node ${process.versions.node}`));

  // 2. 依赖
  let chromium = null;
  try { chromium = require('patchright').chromium; console.log(ok('patchright 已安装')); }
  catch { console.log(bad('patchright 未安装 — 跑 npm install')); problems.push('deps'); }

  // 3. Chrome
  let chrome = cfg.chromePath();
  if (!chrome) {
    chrome = detectChrome();
    if (chrome) {
      console.log(ok(`Chrome 已探测到 ${C.dim}${chrome}${C.reset}`));
      tips.push(`把探测结果固化进 config.yaml（runtime.chrome_path: "${chrome}"）可省去每次探测`);
    } else {
      console.log(bad('找不到 Chrome'));
      problems.push('chrome');
      tips.push('在 config.yaml 里设 runtime.chrome_path 为 Chrome 可执行文件的完整路径');
    }
  } else {
    console.log(fs.existsSync(chrome) ? ok(`Chrome ${C.dim}${chrome}${C.reset}`) : bad(`config 里的 Chrome 路径不存在：${chrome}`));
    if (!fs.existsSync(chrome)) problems.push('chrome');
  }

  // 4. profile
  const profile = cfg.profileDir();
  const profileOk = fs.existsSync(profile);
  console.log(profileOk
    ? ok(`profile 目录 ${C.dim}${profile}${C.reset}`)
    : warn(`profile 目录还不存在（首次运行会自动创建）：${profile}`));

  // 5. CDP
  const cdp = cfg.cdpUrl();
  const port = (cdp.match(/:(\d+)/) || [])[1];
  let info = await cdpInfo(cdp);
  if (!info && chrome && !problems.includes('chrome') && !NO_LAUNCH) {
    console.log(warn('CDP 未在线，正在拉起浏览器…'));
    try {
      launchChrome(chrome, profile, port);
      for (let i = 0; i < 12; i++) {
        await sleep(1000);
        info = await cdpInfo(cdp);
        if (info) break;
      }
    } catch (e) {
      tips.push(`手动拉起浏览器：${chrome} --user-data-dir="${profile}" --remote-debugging-port=${port}`);
    }
  }
  if (info) {
    console.log(ok(`CDP 在线 ${C.dim}${cdp} · ${info.Browser || '?'}${C.reset}`));
  } else {
    console.log(bad(`CDP 不通：${cdp}`));
    problems.push('cdp');
    tips.push(process.platform === 'win32'
      ? '如果报端口被占用/拒绝访问，先查系统保留段：netsh interface ipv4 show excludedportrange protocol=tcp，然后改 config.yaml 的 cdp_url 端口'
      : '手动拉起浏览器并加 --remote-debugging-port');
  }

  // 6. 平台登录态
  if (info && chromium && !NO_LAUNCH) {
    console.log(`\n${C.bold}平台登录态${C.reset} ${C.dim}（逐个打开一次判定，不做任何写操作）${C.reset}`);
    const want = cfg.enabledList().filter((k) => platforms.get(k));
    let browser = null;
    try {
      browser = await chromium.connectOverCDP(cdp, { timeout: 15000 });
      const ctx = browser.contexts()[0];
      const needLogin = [];
      for (const key of want) {
        const p = platforms.get(key);
        if (p.api) {
          const id = cfg.hint('wechat', 'app_id');
          const sec = cfg.hint('wechat', 'app_secret');
          if (id && sec) console.log(ok(`${p.label}  凭证已填`));
          else { console.log(warn(`${p.label}  AppID/AppSecret 未填`)); tips.push('node platforms/wechat.cjs check 可验证公众号 API 连通性'); }
          continue;
        }
        const tab = await ctx.newPage();
        let logged = false;
        try {
          await tab.goto(p.url, { timeout: 25000, waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(1500);
          logged = await p.detect(tab);
        } catch { logged = false; }
        if (logged) console.log(ok(p.label));
        else { console.log(bad(`${p.label}  未登录`)); needLogin.push(p.label); }
        await tab.close().catch(() => {});
        await sleep(500); // 低频：平台间稍作间隔，别把请求打密
      }
      if (needLogin.length) {
        console.log('\n  登录命令：  node bin/login.cjs <平台名>   （不带参数会列出全部可选平台）');
        console.log('  登录完再跑一次 doctor 复核。');
      }
    } catch (e) {
      console.log(warn(`登录态检查跳过：${e.message}`));
    } finally {
      // 刻意不调 browser.close()。
      // patchright 的类型文档对 CDP 连接下的 close() 描述自相矛盾：「Closes the browser
      // and all of its pages」紧跟着「In case this browser is connected to, ... disconnects
      // from the browser server」。前者读起来像杀掉浏览器，后者读起来只是断开。
      // 本命令检查完就退出，进程结束会自动断开，不依赖这个歧义语义——
      // 赌错了的代价是「用户正在填单的 Chrome 被体检命令关掉」。
    }
  } else {
    const off = cfg.enabledList().filter((k) => platforms.get(k));
    if (off.length) {
      console.log(`\n${C.dim}平台登录态未检查（CDP 不通）。以下平台已启用：${off.map((k) => platforms.get(k).label).join('、')}${C.reset}`);
    }
  }

  // ── 汇总 ────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  if (!problems.length) {
    console.log(`${C.green}${C.bold}环境就绪。${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}有 ${problems.length} 项待处理：${problems.join(', ')}${C.reset}`);
  }
  if (tips.length) {
    console.log(`\n${C.bold}提示${C.reset}`);
    tips.forEach((t) => console.log(`  · ${t}`));
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n体检失败：', e.message);
  process.exit(1);
});
