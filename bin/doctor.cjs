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
const driver = require('../lib/driver.cjs');

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

/** ego-browser 探测（与 bin/ego-run.ps1 的解析顺序一致：PATH → 安装目录） */
function detectEgoBrowser() {
  const { spawnSync } = require('child_process');
  try {
    const r = spawnSync('where.exe', ['ego-browser'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout) {
      const hit = r.stdout.split(/\r?\n/).find((l) => l.trim() && /ego/i.test(l));
      if (hit && fs.existsSync(hit.trim())) return hit.trim();
    }
  } catch (_) { /* where 不存在就算了 */ }
  const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const base of bases) {
    for (const sub of ['Citro Labs\\ego lite\\Application', 'Programs\\Citro Labs\\ego lite\\Application']) {
      const root = path.join(base, sub);
      if (!fs.existsSync(root)) continue;
      let best = null;
      try {
        for (const ver of fs.readdirSync(root)) {
          const hit = path.join(root, ver, 'ego-browser.exe');
          if (fs.existsSync(hit)) best = hit; // 目录名即版本号，readdirSync 顺序即可
        }
      } catch (_) { /* 读不了就算了 */ }
      if (best) return best;
    }
  }
  return '';
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
  const channel = driver.configuredChannel();
  console.log(
    `      运行通道：${
      channel === 'ego'
        ? `${C.cyan}ego lite（脚本经 bin/ego-run.ps1 跑在 ego-browser 运行时）${C.reset}`
        : 'playwright + CDP Chrome'
    }`
  );

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) { console.log(bad(`Node ${process.versions.node} 过低，需 >= 18`)); problems.push('node'); }
  else console.log(ok(`Node ${process.versions.node}`));

  // ── ego 通道：体检项完全不同（不碰 patchright / Chrome / CDP / profile）──
  if (channel === 'ego') {
    const ego = detectEgoBrowser();
    if (ego) {
      console.log(ok(`ego-browser 已找到 ${C.dim}${ego}${C.reset}`));
      tips.push('ego lite 每天自动升级，CLI 与 GUI 版本可能错配 —— 报 "Failed to connect to ego_cli" 时重启 ego lite 再试');
    } else {
      console.log(bad('未找到 ego-browser —— ego lite 需要先安装并完成 onboarding（https://lite.ego.app/）'));
      problems.push('ego-browser');
    }
    const prefix = driver.spacePrefix();
    console.log(ok(`TaskSpace 空间前缀 ${C.dim}${prefix}${C.reset}（与 operation 的 op 前缀隔离）`));
    console.log(`\n${C.dim}ego 通道的登录态在 ego lite 自己的 profile 里 —— 在 ego lite 窗口里登录即可，`);
    console.log(`本命令不做逐平台登录态检查。干跑运行器：pwsh -NoProfile -File bin/ego-run.ps1 -WhatIfOnly ...${C.reset}`);
    console.log('\n' + '─'.repeat(60));
    if (!problems.length) console.log(`${C.green}${C.bold}环境就绪。${C.reset}`);
    else console.log(`${C.red}${C.bold}有 ${problems.length} 项待处理：${problems.join(', ')}${C.reset}`);
    if (tips.length) {
      console.log(`\n${C.bold}提示${C.reset}`);
      tips.forEach((t) => console.log(`  · ${t}`));
    }
    console.log('');
    return;
  }

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
    console.log(warn('CDP 未在线，正在拉起浏览器…（**可见窗口，会占用户桌面**）'));
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
  // ⚠️ CDP Chrome 生命周期提示（2026-10-26 加）：
  //    本命令拉起的 CDP Chrome 是 **headed 可见窗口**（会占用户桌面），
  //    而且**它退出后是否还活着没有保证**（用户可能随手关掉，或进程自己退）。
  //    10-26 实测踩坑：doctor 拉起 → 2 分钟后端口已不通（ECONNREFUSED）
  //    → agent 以为「要再拉一次」→ **又弹一次窗**。所以这里退出前**复核一次**，
  //    把状态说清楚，避免重复拉起。
  if (!NO_LAUNCH) {
    const alive = await cdpInfo(cdp);
    if (alive) {
      console.log(`\n${C.dim}CDP Chrome 生命周期：本命令拉起的浏览器**仍在后台运行**（${cdp}）——`
        + `后续 B 通道脚本可直接连，**不要重复拉起**（再拉会弹第二个窗口）。`
        + `用完可关掉它。${C.reset}`);
    } else if (chrome) {
      console.log(`\n${C.yellow}CDP Chrome 生命周期：浏览器**已不在**（${cdp} 不通）——`
        + `多半是它已被关掉或已退出。${C.reset}`);
      console.log(`${C.yellow}  下次要连 CDP 时**只拉一次**（本命令会自动拉，或手动跑 launch-cdp-chrome.cmd），`
        + `别连着拉两次——每拉一次都会弹一个可见窗口。${C.reset}`);
    }
  }

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
