// bin/probe-ego.cjs — ego 通道探针本体（经 bin/ego-run.ps1 在 ego 运行时里跑）
//
// 做三件事：导航 → 取标题（evaluate）→ 截图。每步独立判 ok/FAIL，失败后续步骤 skip。
// **只探测，不填单**：开一个临时空间，用完 task.finish({keep:[]}) 关掉。
//
// 输出契约（机器可读，供编排层 bin/channel-probe.cjs 解析）：
//   CHANNEL_PROBE: nav=ok eval=ok shot=ok spaceId=44 ms=1234
//   CHANNEL_PROBE: nav=FAIL(<原因>) eval=skip shot=skip spaceId=- ms=20000
// 退出码：0 = 通道可用（nav+eval 通过）；2 = 通道不可用（nav 或 eval 失败）。
//         shot 失败**不算**通道不可用 —— 填单判据全在 DOM，截图只是留档（生产环境
//         2026-10-24 实测：截图通道会单独卡死，其余一切正常）。
//
// 截图落盘路径由调用方经 -ScriptArgs 传入（ego 的 cwd 是安装目录，必须绝对路径）。

(async () => {
  const t0 = Date.now();
  const out = { nav: '', eval: '', shot: '', spaceId: '-' };
  const args = (globalThis.__KIT_ARGS__ || {});
  const clip = (s) => `FAIL(${String(s || 'unknown').replace(/\s+/g, ' ').slice(0, 80)})`;
  let task = null;

  try {
    task = await taskSpace('pk-probe-' + Date.now().toString(36));
    out.spaceId = task.spaceId ?? '-';
  } catch (e) {
    console.error('探针：开空间失败 ——', e.message);
    console.log(`CHANNEL_PROBE: nav=${clip(e.message)} eval=skip shot=skip spaceId=- ms=${Date.now() - t0}`);
    process.exit(2);
  }

  try {
    const pages = await task.tabs();
    const page = pages[0] && pages[0].page ? pages[0].page : await task.newPage();
    try {
      await page.goto('https://example.com');
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
    } else {
      out.eval = 'skip';
    }
    if (args.screenshot && out.nav === 'ok') {
      try {
        await page.screenshot({ path: String(args.screenshot).replace(/\\/g, '/') });
        out.shot = 'ok';
      } catch (e) {
        out.shot = clip(e.message);
      }
    } else {
      out.shot = out.nav === 'ok' ? 'skip(未指定路径)' : 'skip';
    }
  } finally {
    try { await task.finish({ keep: [] }); } catch { /* 收尾失败不影响探针结论 */ }
  }

  console.log(`CHANNEL_PROBE: nav=${out.nav} eval=${out.eval} shot=${out.shot} spaceId=${out.spaceId} ms=${Date.now() - t0}`);
  const usable = out.nav === 'ok' && out.eval === 'ok';
  if (!usable) {
    console.error('❌ ego 通道不可用（导航/执行失败）—— 先修环境再填单');
    process.exit(2);
  }
  if (!out.shot.startsWith('ok')) {
    console.error(`⚠ 截图通道异常（${out.shot}）—— 填单判据全在 DOM，不影响填单，只是没有留档`);
  }
  process.exit(0);
})();
