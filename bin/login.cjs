#!/usr/bin/env node
// bin/login.cjs — 打开平台登录页
//
// 只开页面，不做任何点击或填写。扫码/验证码一律交给用户。
// 登录完成后重跑 node bin/doctor.cjs 复核。
//
//   node bin/login.cjs                列出全部平台
//   node bin/login.cjs bilibili weibo 打开指定平台的登录页（中文名也行）
//   node bin/login.cjs --all          打开所有已启用的平台
const cfg = require('../lib/config.cjs');
const platforms = require('../lib/platforms.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', cyan: '\x1b[36m',
};

function usage() {
  console.log(`\n${C.bold}打开平台登录页${C.reset}\n`);
  console.log('  用法：node bin/login.cjs [平台...] | --all\n');
  console.log('  可用平台（中文名或英文 key 都行）：');
  for (const k of platforms.keys()) {
    const p = platforms.get(k);
    const tag = p.api ? `${C.dim}（API 通道，不需登录）${C.reset}` : '';
    const on = cfg.exists() && cfg.enabled(k) ? `${C.green}已启用${C.reset}` : `${C.dim}未启用${C.reset}`;
    console.log(`    ${p.label.padEnd(6, '　')} ${k.padEnd(11)} ${on} ${tag}`);
  }
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    usage();
    return;
  }
  if (!cfg.exists()) {
    console.error('\n✗ 找不到 config.yaml。先跑：node bin/init.cjs\n');
    process.exit(1);
  }

  let want;
  if (argv.includes('--all')) {
    want = cfg.enabledList();
  } else {
    want = argv.map(platforms.resolve);
    const bad = argv.filter((a, i) => !want[i]);
    if (bad.length) {
      console.error(`\n✗ 认不出的平台：${bad.join(', ')}\n`);
      usage();
      process.exit(1);
    }
  }

  const browserTargets = want.filter((k) => !platforms.get(k).api);
  const apiTargets = want.filter((k) => platforms.get(k).api);
  for (const k of apiTargets) {
    const p = platforms.get(k);
    console.log(`${C.dim}· ${p.label}：走官方 API，不需要浏览器登录。请确认 config.yaml 里 app_id / app_secret 已填。${C.reset}`);
  }
  if (!browserTargets.length) return;

  let chromium;
  try {
    chromium = require('patchright').chromium;
  } catch {
    console.error('\n✗ patchright 未安装。跑：npm install\n');
    process.exit(1);
  }

  const cdp = cfg.cdpUrl();
  console.log(`\n连接 ${C.cyan}${cdp}${C.reset} …`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdp, { timeout: 15000 });
  } catch {
    console.error(`\n✗ 连不上 CDP（${cdp}）。先跑 node bin/doctor.cjs 让它把浏览器拉起来。\n`);
    process.exit(1);
  }

  const ctx = browser.contexts()[0];
  const opened = [];
  for (const k of browserTargets) {
    const p = platforms.get(k);
    try {
      const tab = await ctx.newPage();
      await tab.goto(p.url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1200);
      const logged = await p.detect(tab);
      opened.push({ label: p.label, logged, tab });
      console.log(
        logged
          ? `  ✓ ${p.label}  已登录（可以直接发布）`
          : `  → ${p.label}  页面已打开，请在该窗口完成扫码/登录`
      );
    } catch (e) {
      console.log(`  ✗ ${p.label}  打不开：${e.message}`);
    }
  }

  if (opened.some((o) => !o.logged)) {
    console.log(`\n${C.bold}请在弹出的浏览器窗口里完成登录。${C.reset}`);
    console.log(`${C.dim}本命令不会点击任何登录按钮，也读不到你的密码——只开页面。${C.reset}`);
    console.log(`${C.dim}登录完成后重跑：node bin/doctor.cjs 复核${C.reset}\n`);
  } else {
    console.log(`\n${C.green}${C.bold}全部已登录，无需操作。${C.reset}\n`);
  }

  // 刻意不调 browser.close()——本命令开完登录页就退出，用户还要在那几个标签页里扫码，
  // 万一 close() 的语义是「关掉浏览器」而不是「断开连接」，等于把刚开的登录页关了。
  // 进程退出即自动断开。
}

main().catch((e) => {
  console.error('\n失败：', e.message);
  process.exit(1);
});
