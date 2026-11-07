#!/usr/bin/env node
// bin/channel-probe.cjs — 失败后通道探针（只探测，不填单）
//
// 一批填单有槽位失败时跑这个：**先分辨「环境坏了」还是「平台坏了」**，
// 再决定重跑还是修环境 —— 盲目重跑只会白烧一轮。
//
//   node bin/channel-probe.cjs                    # 按 config.runtime.driver 探当前通道
//   node bin/channel-probe.cjs --driver playwright
//   node bin/channel-probe.cjs --driver ego
//
// 探测三步（对齐生产库 2026-10-27 协议）：导航 example.com → evaluate 取标题 → 截图。
// 输出契约（机器可读）：`CHANNEL_PROBE: nav=<ok|FAIL(..)> eval=.. shot=.. [spaceId=N] ms=N`
// 退出码：0 = 通道可用；2 = 通道不可用（nav/eval 失败）。shot 失败不算通道死
// —— 填单判据全在 DOM，截图只是留档。
//
// 编排层（bin/publish-manifest.cjs）在槽位失败后自动调用并解析本输出给出三分类判定。

const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('../lib/config.cjs');
const driver = require('../lib/driver.cjs');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const which =
    args.driver && args.driver !== true
      ? String(args.driver).trim().toLowerCase()
      : driver.configuredChannel();

  // ── ego 通道：探针本体必须在 ego 运行时里跑 → 经 bin/ego-run.ps1 派发 ──
  if (which === 'ego') {
    const shot = path.join(cfg.logDir(), 'channel-probe.png');
    const r = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        path.join(cfg.ROOT, 'bin', 'ego-run.ps1'),
        '-Script',
        path.join(cfg.ROOT, 'bin', 'probe-ego.cjs'),
        '-ScriptArgs',
        JSON.stringify({ screenshot: shot.replace(/\\/g, '/') }),
      ],
      { cwd: cfg.ROOT, stdio: 'inherit', env: { ...process.env } }
    );
    process.exit(r.status === 0 ? 0 : 2);
  }

  // ── playwright 通道：直接 CDP 连外部 Chrome，同样三步 ──
  const t0 = Date.now();
  const out = { nav: '', eval: '', shot: '' };
  const clip = (s) => `FAIL(${String(s || 'unknown').replace(/\s+/g, ' ').slice(0, 80)})`;
  let browser = null;
  let chromium = null;
  try {
    chromium = require('patchright').chromium;
  } catch {
    console.error('patchright 未安装。在 publish-kit 目录下跑：npm install');
    console.log(`CHANNEL_PROBE: nav=${clip('patchright missing')} eval=skip shot=skip ms=${Date.now() - t0}`);
    process.exit(2);
  }
  try {
    browser = await chromium.connectOverCDP(process.env.CDP_URL || cfg.cdpUrl(), { timeout: 15000 });
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    try {
      await page.goto('https://example.com', { timeout: 20000 });
      out.nav = 'ok';
    } catch (e) {
      out.nav = clip(e.message);
    }
    if (out.nav === 'ok') {
      try {
        await page.evaluate(() => document.title);
        out.eval = 'ok';
      } catch (e) {
        out.eval = clip(e.message);
      }
    } else out.eval = 'skip';
    if (out.nav === 'ok') {
      try {
        await page.screenshot({ path: path.join(cfg.logDir(), 'channel-probe.png'), timeout: 6000 });
        out.shot = 'ok';
      } catch (e) {
        out.shot = clip(e.message);
      }
    } else out.shot = 'skip';
    try { await page.close(); } catch { /* ignore */ }
  } catch (e) {
    if (!out.nav) out.nav = clip(e.message);
    if (!out.eval) out.eval = 'skip';
    if (!out.shot) out.shot = 'skip';
  } finally {
    try { if (browser) await browser.close(); } catch { /* ignore */ }
  }

  console.log(`CHANNEL_PROBE: nav=${out.nav} eval=${out.eval} shot=${out.shot} spaceId=- ms=${Date.now() - t0}`);
  const usable = out.nav === 'ok' && out.eval === 'ok';
  if (!usable) {
    console.error('❌ playwright/CDP 通道不可用 —— 检查 Chrome 是否在跑、CDP 端口是否对');
    process.exit(2);
  }
  if (!out.shot.startsWith('ok')) {
    console.error(`⚠ 截图通道异常（${out.shot}）—— 填单判据全在 DOM，不影响填单`);
  }
  process.exit(0);
})();
