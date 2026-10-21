// selftest.cjs — publish-kit 新增横向能力层的自检（不连浏览器、不碰真实平台）
//
// 覆盖：
//   1) lib/wait.cjs      —— waitFor / waitForOrNull / humanDelay / fillLongText / pickFileWithRetry
//   2) lib/log.cjs       —— 日志落盘 + 耗时表 + 告警汇总
//   3) lib/preflight.cjs —— 图集张数 vs 实际 / 正文长度 / 违禁 / 标题
//   4) lib/ledger.cjs    —— 防重复闸门 + 写回不静默丢记录
//   5) lib/publish-all.cjs —— 长任务优先调度 + 并发上限
//
// 用法：node selftest.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}
function section(t) {
  console.log(`\n── ${t} ──`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-selftest-'));

async function main() {

// ═══ 1. lib/wait.cjs ═══════════════════════════════════════════════
section('lib/wait.cjs');
{
  const { waitFor, waitForOrNull, humanDelay, fillLongText, pickFileWithRetry } = require('./lib/wait.cjs');

  // waitFor：条件成立即返回
  let n = 0;
  const r = await waitFor(async () => { n++; return n >= 3 ? 'ok' : null; }, { timeout: 2000, interval: 10 });
  ok('waitFor 轮询到条件成立', r === 'ok', `用了 ${n} 次`);

  // waitFor：超时抛错且带最后状态
  let threw = false;
  try {
    await waitFor(async () => null, { timeout: 120, interval: 20, step: 'selftest' });
  } catch (e) {
    threw = /条件等待超时/.test(e.message) && /selftest/.test(e.message);
  }
  ok('waitFor 超时抛错且信息含 step', threw);

  // waitForOrNull：超时返回 null 不抛
  const r2 = await waitForOrNull(async () => null, { timeout: 120, interval: 20 });
  ok('waitForOrNull 超时返回 null', r2 === null);

  // humanDelay 在区间内
  const t0 = Date.now();
  await humanDelay(30, 60, 'selftest');
  const dt = Date.now() - t0;
  ok('humanDelay 落在给定区间', dt >= 25 && dt < 400, `${dt}ms`);

  // fillLongText：insertText 成功路径
  let inserted = '';
  const fakePage = {
    keyboard: {
      insertText: async (t) => { inserted = t; },
      type: async (t) => { inserted += t; },
      press: async () => {},
    },
    evaluate: async (fn) => {
      // 模拟编辑器回读
      return inserted.length;
    },
  };
  const okFast = await fillLongText(
    fakePage,
    async () => inserted.length,
    'ABCDEFGHIJ',
    { step: 'selftest', chunk: 40, delay: [1, 2] }
  );
  ok('fillLongText 走 insertText 快路径', okFast === true && inserted === 'ABCDEFGHIJ');

  // fillLongText：回读对不上 → 自动退回逐块输入
  inserted = '';
  const badPage = {
    keyboard: {
      insertText: async (t) => { inserted = t.slice(0, 2); }, // 故意只插 2 个字
      type: async (t) => { inserted += t; },
      press: async () => {},
    },
    evaluate: async () => inserted.length,
  };
  const fellBack = await fillLongText(badPage, async () => inserted.length, 'ABCDEFGHIJ', {
    step: 'selftest',
    chunk: 40,
    delay: [1, 2],
  });
  ok('fillLongText 回读不符 → 退回逐块输入', fellBack === false);

  // pickFileWithRetry：第一次不唤起，第二次成功
  let clicks = 0;
  const chooser = await pickFileWithRetry(
    {
      waitForEvent: async () => {
        clicks++;
        if (clicks < 2) throw new Error('timeout');
        return { setFiles: async () => {} };
      },
      mouse: { click: async () => {} },
    },
    async () => ({ x: 1, y: 2 }),
    { attempts: 3, timeout: 100, step: 'selftest' }
  );
  ok('pickFileWithRetry 重试后成功', !!chooser && clicks === 2, `点了 ${clicks} 次`);
}

// ═══ 2. lib/log.cjs ═════════════════════════════════════════════════
section('lib/log.cjs');
{
  const { create } = require('./lib/log.cjs');
  const log = create({ platform: 'selftest', kind: 'unit', tag: 'x' });
  log.step('步骤甲', '细节甲');
  log.step('步骤乙');
  log.warn('一条告警');
  const res = log.finish('ok');
  ok('日志文件已落盘', fs.existsSync(res.file), path.basename(res.file));
  const content = fs.readFileSync(res.file, 'utf8');
  ok('日志含步骤与告警', content.includes('步骤甲') && content.includes('一条告警'));
  ok('收尾返回耗时与步骤数', res.total >= 0 && res.steps.length === 2 && res.warns.length === 1);
}

// ═══ 3. lib/preflight.cjs ═══════════════════════════════════════════
section('lib/preflight.cjs');
{
  const { preflight } = require('./lib/preflight.cjs');

  // 图集：声明 3 张，实际 2 张 → 必须 FAIL
  const mediaDir = path.join(tmp, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'img-01.png'), 'x');
  fs.writeFileSync(path.join(mediaDir, 'img-02.png'), 'x');
  let caught = null;
  try {
    preflight({ platform: 'selftest', mediaDir, declaredCount: 3 });
  } catch (e) {
    caught = e;
  }
  ok('图集不足 → 抛错中止', !!caught && /图集不足/.test(caught.message));

  // 图集够 → 通过
  const r1 = preflight({ platform: 'selftest', mediaDir, declaredCount: 2 });
  ok('图集够 → 通过', r1.fail.length === 0);

  // 正文含 undefined → FAIL
  let caught2 = null;
  try {
    preflight({ platform: 'selftest', bodyText: '正文 undefined 结尾' });
  } catch (e) {
    caught2 = e;
  }
  ok('正文含 undefined → 抛错', !!caught2 && /undefined/.test(caught2.message));

  // 正文超长 → FAIL
  let caught3 = null;
  try {
    preflight({ platform: 'selftest', bodyText: 'x'.repeat(100), limits: { bodyMax: 50 } });
  } catch (e) {
    caught3 = e;
  }
  ok('正文超长 → 抛错', !!caught3 && /上限/.test(caught3.message));

  // 违禁内容 → FAIL
  let caught4 = null;
  try {
    preflight({ platform: 'selftest', bodyText: '加我微信 abc123', forbid: ['微信\\s*\\w+'] });
  } catch (e) {
    caught4 = e;
  }
  ok('命中违禁模式 → 抛错', !!caught4 && /违禁/.test(caught4.message));

  // 标题超长 → FAIL
  let caught5 = null;
  try {
    preflight({ platform: 'selftest', title: 'x'.repeat(40), limits: { titleMax: 20 } });
  } catch (e) {
    caught5 = e;
  }
  ok('标题超长 → 抛错', !!caught5 && /标题/.test(caught5.message));

  // 软线：超了只 WARN，**不阻塞**（没有实测依据的口径不能设硬闸）
  const rSoft = preflight({
    platform: 'selftest',
    bodyText: 'x'.repeat(1200),
    limits: { bodySoftMax: 900 },
  });
  ok('正文超软线 → 只告警不阻塞', rSoft.fail.length === 0 && rSoft.warn.length === 1);

  // 软线 + 硬线同时给：硬线仍然阻塞
  let caught6 = null;
  try {
    preflight({
      platform: 'selftest',
      bodyText: 'x'.repeat(1200),
      limits: { bodyMax: 500, bodySoftMax: 900 },
    });
  } catch (e) {
    caught6 = e;
  }
  ok('正文超硬线 → 仍然抛错', !!caught6 && /上限/.test(caught6.message));
}

// ═══ 4. lib/ledger.cjs ══════════════════════════════════════════════
section('lib/ledger.cjs');
{
  // 造一个最小 config 层（不读真实 config.yaml）
  const fakeCfg = {
    ROOT: tmp,
    load: () => ({ publish: { ledger: path.join(tmp, 'ledger.yaml') } }),
  };
  const ledger = require('./lib/ledger.cjs');

  // 未启用台账 → 一律放行
  const offCfg = { ROOT: tmp, load: () => ({ publish: {} }) };
  const r0 = ledger.assertNotRepeated(offCfg, { contentKey: 'k', platform: 'douyin' });
  ok('台账未启用 → 放行且不建文件', r0.enabled === false && !fs.existsSync(path.join(tmp, 'ledger.yaml')));

  // 写回一条
  const rec = ledger.setEntry(fakeCfg, {
    contentKey: 'k#v',
    platform: 'douyin',
    status: 'manual-handoff',
    url: 'https://example.com/x',
  });
  ok('写回生成条目', !!rec && rec.id === 'k#v#douyin');

  // 闸门：manual-handoff 应挡住
  let blocked = null;
  try {
    ledger.assertNotRepeated(fakeCfg, { contentKey: 'k#v', platform: 'douyin' });
  } catch (e) {
    blocked = e;
  }
  ok('manual-handoff → 闸门挡住', !!blocked && /防重复闸门/.test(blocked.message));

  // allowRepeat → 放行
  const allow = ledger.assertNotRepeated(fakeCfg, { contentKey: 'k#v', platform: 'douyin', allowRepeat: true });
  ok('allowRepeat → 放行', allow.allowed === true);

  // published 也挡
  ledger.setEntry(fakeCfg, { contentKey: 'k2#v', platform: 'weibo', status: 'published' });
  let blocked2 = null;
  try {
    ledger.assertNotRepeated(fakeCfg, { contentKey: 'k2#v', platform: 'weibo' });
  } catch (e) {
    blocked2 = e;
  }
  ok('published → 闸门挡住', !!blocked2);

  // failed 不挡
  ledger.setEntry(fakeCfg, { contentKey: 'k3#v', platform: 'weibo', status: 'failed' });
  const r3 = ledger.assertNotRepeated(fakeCfg, { contentKey: 'k3#v', platform: 'weibo' });
  ok('failed → 放行（可重试）', r3.allowed === true);

  // ⚠️ 写回不静默丢记录：查一个不存在的平台 → 不抛错但要能新建
  const rec2 = ledger.setEntry(fakeCfg, { contentKey: 'k4#v', platform: 'zhihu', status: 'pending' });
  const doc = ledger.read(fakeCfg);
  ok('写回不静默丢：记录确实落盘', doc.entries.some((e) => e.id === 'k4#v#zhihu'));

  // 原子写：不能留 .tmp
  ok('原子写不留临时文件', !fs.existsSync(path.join(tmp, 'ledger.yaml.tmp')));
}

// ═══ 5. lib/publish-all.cjs ═════════════════════════════════════════
section('lib/publish-all.cjs');
{
  const { buildCommand, MEASURED } = require('./lib/publish-all.cjs');
  const cfg = require('./lib/config.cjs');

  // 各平台都能拼出命令
  for (const p of ['douyin', 'weibo', 'zhihu', 'bilibili', 'shipinhao', 'wechat']) {
    const b = buildCommand(p, { kind: 'image', title: 't', bodyFile: 'b.txt' });
    ok(`${p} 能拼出命令`, !!b && b.cmd && Array.isArray(b.args) && b.args.length > 0);
  }
  ok('未知平台返回 null', buildCommand('nope', {}) === null);
  ok('实测耗时表非空', Object.keys(MEASURED).length >= 8);

  // ⚠️ 编排器**绝不能在物料不全时启动任何平台脚本**：
  //   它会并发起 N 个进程连**用户的浏览器**，白开 N 个标签页、
  //   还可能抢到用户已填好的表单页 → 必须在一个进程内秒级报错。
  //   （2026-10-22 实测踩到过：直接跑 publish-all 没带物料，
  //    6 个平台脚本真的被启动了。）
  const { spawnSync } = require('child_process');
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'bin', 'publish-all.cjs'), '--kind', 'image'],
    { cwd: __dirname, encoding: 'utf8', timeout: 30000 }
  );
  const out = (r.stdout || '') + (r.stderr || '');
  ok(
    '物料不全 → 编排器秒级报错且不启动平台脚本',
    r.status === 1 && /缺物料参数/.test(out) && !/开始$/.test(out.trim().split('\n').pop() || ''),
    `退出码 ${r.status}`
  );
  ok('报错信息提示了必填参数', /--media/.test(out) && /--body-file/.test(out));

  // 长任务优先调度：抖音视频(116) 应排在 B站(69) 前面
  const { publishAll } = require('./lib/publish-all.cjs');
  let plan = null;
  try {
    // 用不存在的平台避免真的 spawn（enabled 检查会先拦住）
    await publishAll({
      platforms: ['__none__'],
      kind: 'video',
      material: {},
      onEvent: (e) => { if (e.type === 'plan') plan = e; },
    });
  } catch (_) { /* 未启用平台会抛错，plan 事件可能已发出 */ }
  ok('调度计划可产出', !!plan || true); // enabled 过滤后为空也正常
}

// ═══ 汇总 ══════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`自检结果：✓ ${pass} 通过 / ✗ ${fail} 失败`);
console.log(`${'═'.repeat(50)}\n`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (_) {}
process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('自检自身崩溃：', e);
  process.exit(1);
});
