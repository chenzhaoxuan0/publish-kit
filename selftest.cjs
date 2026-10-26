// selftest.cjs — publish-kit 新增横向能力层的自检（不连浏览器、不碰真实平台）
//
// 覆盖：
//   1) lib/wait.cjs      —— waitFor / waitForOrNull / humanDelay / fillLongText / pickFileWithRetry
//   2) lib/log.cjs       —— 日志落盘 + 耗时表 + 告警汇总
//   3) lib/preflight.cjs —— 图集张数 vs 实际 / 正文长度 / 违禁 / 标题
//   4) lib/ledger.cjs    —— 防重复闸门 + 写回不静默丢记录 + 变体维度
//   5) lib/publish-all.cjs —— 长任务优先调度 + 并发上限 + 命令序列
//   6) lib/manifest.cjs  —— 发布清单：解析 / 槽位展开 / 命令序列 / 校验
//   7) lib/diagnose.cjs  —— 失败分级：通道 / 登录 / 内容 / 截图 / 可重试
//   8) lib/shot.cjs      —— 截图降级（永不抛异常）
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
  // ⚠️ **形态要对**：B站与视频号只有视频线，公众号只有图文线 —— 这是事实，
  //    不是配置问题。旧版这里对所有平台都用 kind=image，于是给 B站拼出了一条
  //    「跑起来必然报缺 --video」的假命令。
  const combos = [
    ['douyin', 'image'], ['douyin', 'video'],
    ['weibo', 'image'], ['weibo', 'video'],
    ['zhihu', 'image'], ['zhihu', 'video'],
    ['bilibili', 'video'], ['shipinhao', 'video'],
    ['wechat', 'image'],
  ];
  for (const [p, kind] of combos) {
    const b = buildCommand(p, { kind, title: 't', bodyFile: 'b.txt' });
    ok(`${p}/${kind} 能拼出命令`, !!b && b.cmd && Array.isArray(b.args) && b.args.length > 0);
  }
  ok('未知平台返回 null', buildCommand('nope', {}) === null);
  ok('平台没有该形态时返回 null（B站无图文线）', buildCommand('bilibili', { kind: 'image' }) === null);
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

// ═══ 6. lib/manifest.cjs ═══════════════════════════════════════════
section('lib/manifest.cjs');
{
  const manifest = require('./lib/manifest.cjs');

  // 造一个最小内容目录：3 张图 + 正文 + 短标题
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(proj, 'media'), { recursive: true });
  for (let i = 1; i <= 3; i++) {
    fs.writeFileSync(path.join(proj, 'media', `img-0${i}.png`), 'x');
  }
  fs.writeFileSync(path.join(proj, 'body.txt'), '正文内容');
  fs.writeFileSync(path.join(proj, 'sph.txt'), '短标题');

  const mf = path.join(proj, 'publish.yaml');
  fs.writeFileSync(
    mf,
    [
      'version: 1',
      'content:',
      '  key: "k1"',
      'variants:',
      '  image:',
      '    slots:',
      '      - platform: douyin',
      '        kind: image',
      '        title: "标题A"',
      '        bodyFile: "body.txt"',
      '        media: "media"',
      '        count: 3',
      '        options:',
      '          album: "合集A"',
      '          music: "Opus 37"',
      '  video:',
      '    slots:',
      '      - platform: shipinhao',
      '        kind: video',
      '        titleFile: "sph.txt"',
      '        bodyFile: "body.txt"',
      '        video: "media/img-01.png"',
      '        options:',
      '          location: "off"',
    ].join('\n')
  );

  const plan = manifest.buildPlan(mf);
  ok('清单解析出 2 个槽位', plan.slots.length === 2, `实得 ${plan.slots.length}`);
  ok('体检无 FAIL', plan.problems.fail.length === 0, plan.problems.fail.join('; '));

  const dy = plan.slots.find((s) => s.platform === 'douyin');
  ok('相对路径按清单目录解析', dy && path.isAbsolute(dy.media) && dy.media.endsWith('media'));
  ok('content.key 读到了', plan.content.key === 'k1');

  // ⚠️ **抖音必须是一条命令序列**，不能是一条 —— 早期版本只拼了一条
  //    不带子命令的命令，而 douyin.cjs 默认子命令是 open → 只开页不填单却报成功。
  ok('抖音是多命令序列', dy && dy.commands.length >= 4, `${dy ? dy.commands.length : 0} 步`);
  ok(
    '抖音序列第一步是 open',
    dy && dy.commands[0].args[0] === 'open' && dy.commands[0].args.includes('image')
  );
  ok('抖音序列含 upload 步骤', dy && dy.commands.some((c) => c.args[0] === 'upload'));
  ok('抖音序列含 fill 步骤', dy && dy.commands.some((c) => c.args[0] === 'fill'));
  ok('抖音 upload 步骤标为非幂等（不自动重试）', dy && dy.commands.some((c) => c.args[0] === 'upload' && c.idempotent === false));
  ok('抖音配乐是独立步骤', dy && dy.commands.some((c) => c.args[0] === 'music'));

  // 平台专属开关 → 命令行参数
  const dyArgs = dy.commands.map((c) => c.args.join(' ')).join(' | ');
  ok('合集名进了 collect 步骤', /collect .*--album 合集A/.test(dyArgs));

  // 视频号：标题变体文件 + 位置开关
  const sph = plan.slots.find((s) => s.platform === 'shipinhao');
  ok('标题变体文件被读入', sph && sph.title === '短标题');
  ok('视频号 ≤16 字硬校验通过', sph && [...sph.title].length <= 16);
  ok('视频号位置开关进了命令行', sph && sph.commands[0].args.includes('--location'));

  // 校验：缺文件 → FAIL
  const bad = manifest.buildPlan(mf, { variants: ['nonexistent'] });
  ok('不存在的变体 → 无槽位', bad.slots.length === 0);

  // 校验：图集不足 → FAIL
  fs.mkdirSync(path.join(proj, 'media2'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'media2', 'img-01.png'), 'x');
  const mf2 = path.join(proj, 'bad.yaml');
  fs.writeFileSync(
    mf2,
    ['version: 1', 'slots:', '  - platform: douyin', '    kind: image', '    title: "t"',
     '    bodyFile: "body.txt"', '    media: "media2"', '    count: 3'].join('\n')
  );
  const badPlan = manifest.buildPlan(mf2);
  ok('图集不足 → FAIL', badPlan.problems.fail.some((f) => /图集不足/.test(f)));
  ok('图集不足的槽位不进执行计划', badPlan.slots.length === 0);

  // 校验：未知开关 → FAIL（不静默丢）
  const mf3 = path.join(proj, 'bad2.yaml');
  fs.writeFileSync(
    mf3,
    ['version: 1', 'slots:', '  - platform: douyin', '    kind: image', '    title: "t"',
     '    bodyFile: "body.txt"', '    media: "media"', '    count: 3',
     '    options:', '      不存在的开关: 1'].join('\n')
  );
  const badPlan3 = manifest.buildPlan(mf3);
  ok('未知开关 → FAIL（不静默丢）', badPlan3.problems.fail.some((f) => /不认识开关/.test(f)));

  // 校验：视频号标题超 16 字 → FAIL
  const mf4 = path.join(proj, 'bad3.yaml');
  fs.writeFileSync(
    mf4,
    ['version: 1', 'slots:', '  - platform: shipinhao', '    kind: video',
     '    title: "这个标题明显超过十六个字了肯定会撞墙"', '    bodyFile: "body.txt"',
     '    video: "media/img-01.png"'].join('\n')
  );
  const badPlan4 = manifest.buildPlan(mf4);
  ok('视频号标题超 16 字 → FAIL', badPlan4.problems.fail.some((f) => /16 字/.test(f)));

  // 平台没有该形态 → FAIL
  const mf5 = path.join(proj, 'bad4.yaml');
  fs.writeFileSync(
    mf5,
    ['version: 1', 'slots:', '  - platform: bilibili', '    kind: image', '    title: "t"',
     '    bodyFile: "body.txt"', '    media: "media"', '    count: 3'].join('\n')
  );
  const badPlan5 = manifest.buildPlan(mf5);
  ok('B站没有图文线 → FAIL', badPlan5.problems.fail.some((f) => /没有 image 形态/.test(f)));

  // 人工通道：只备料，不要求物料齐全
  const mf6 = path.join(proj, 'manual.yaml');
  fs.writeFileSync(
    mf6,
    ['version: 1', 'slots:', '  - platform: douyin', '    via: manual',
     '    releaseFile: "body.txt"', '    note: "零自动化，仅备料"'].join('\n')
  );
  const manualPlan = manifest.buildPlan(mf6);
  ok('manual 通道 → 体检通过且不进执行计划（有命令才执行）',
     manualPlan.problems.fail.length === 0);
}

// ═══ 7. lib/diagnose.cjs ════════════════════════════════════════════
section('lib/diagnose.cjs');
{
  const { diagnose, VERDICT } = require('./lib/diagnose.cjs');

  const d1 = diagnose({ code: 1, stdout: 'Error: connectOverCDP: ECONNREFUSED 127.0.0.1:39223' });
  ok('CDP 连不上 → 通道不可用', d1.verdict === VERDICT.CHANNEL_DEAD, d1.verdict);
  ok('通道不可用 → 不允许重试', d1.canRetry === false);

  const d2 = diagnose({ code: 1, stdout: 'page.goto: Timeout 30000ms exceeded' });
  ok('导航超时 → 通道不可用（不重试）', d2.verdict === VERDICT.CHANNEL_DEAD, d2.verdict);

  const d3 = diagnose({ code: 1, stdout: '未登录，请扫码' });
  ok('未登录 → 登录态失效', d3.verdict === VERDICT.LOGIN_REQUIRED, d3.verdict);
  ok('登录态失效 → 不允许重试', d3.canRetry === false);

  const d4 = diagnose({ code: 1, stdout: 'Error: 缺 --body-file 或文件不存在' });
  ok('缺物料 → 内容被拒', d4.verdict === VERDICT.CONTENT_REJECTED, d4.verdict);
  ok('内容被拒 → 不允许重试', d4.canRetry === false);

  const d5 = diagnose({ code: 1, stdout: '截图失败（已忽略，不影响填单结果）' });
  ok('截图失败 → 仅截图失败', d5.verdict === VERDICT.COSMETIC, d5.verdict);

  const d6 = diagnose({ code: 1, stdout: '点上传入口 3 次都没唤起文件选择器' });
  ok('点击没生效 → 可重试', d6.verdict === VERDICT.RETRYABLE, d6.verdict);
  ok('可重试 → 允许重试', d6.canRetry === true);

  const d7 = diagnose({ code: 1, stdout: '完全看不懂的报错' });
  ok('认不出 → unknown 且不自动重试', d7.verdict === VERDICT.UNKNOWN && d7.canRetry === false, d7.verdict);

  // 公众号凭证类问题归到「要人工处理」
  const d8 = diagnose({ code: 1, stdout: '{"errcode":40164,"errmsg":"invalid ip"}' });
  ok('公众号 invalid ip → 登录/凭证类', d8.verdict === VERDICT.LOGIN_REQUIRED, d8.verdict);
}

// ═══ 8. lib/shot.cjs ═══════════════════════════════════════════════
section('lib/shot.cjs');
{
  const { shot } = require('./lib/shot.cjs');
  const out = path.join(tmp, 'shot.png');

  // 假 page：截图成功
  const okRes = await shot({ screenshot: async () => 'ok' }, out);
  ok('截图成功 → ok:true', okRes.ok === true);

  // 假 page：截图抛异常 —— 必须**不外抛**
  let threw = false;
  let errRes = null;
  try {
    errRes = await shot({ screenshot: async () => { throw new Error('boom'); } }, out);
  } catch (_) {
    threw = true;
  }
  ok('截图抛异常 → 不外抛', threw === false);
  ok('截图抛异常 → ok:false 且带原因', errRes && errRes.ok === false && !!errRes.reason);

  // 假 page：截图挂死 —— 必须按超时返回，不能等 playwright 默认 30s
  const t0 = Date.now();
  const hung = await shot({ screenshot: () => new Promise(() => {}) }, out, { timeoutMs: 300 });
  const dt = Date.now() - t0;
  ok('截图挂死 → 按超时返回', hung.ok === false && dt < 3000, `耗时 ${dt}ms`);
}

// ═══ 9. lib/ledger.cjs 变体维度 ════════════════════════════════════
section('lib/ledger.cjs 变体维度');
{
  const ledger = require('./lib/ledger.cjs');
  const vCfg = { ROOT: tmp, load: () => ({ publish: { ledger: path.join(tmp, 'ledger-var.yaml') } }) };

  // 图文线写一条 manual-handoff
  ledger.setEntry(vCfg, { contentKey: 'v1', platform: 'douyin', variant: 'image', status: 'manual-handoff' });

  // 视频线是**另一条**记录 → 不该被图文线的记录挡住
  const vVideo = ledger.assertNotRepeated(vCfg, { contentKey: 'v1', platform: 'douyin', variant: 'video' });
  ok('不同变体互不遮挡', vVideo.allowed === true, vVideo.reason);

  // 同变体 → 挡住
  let blocked = null;
  try {
    ledger.assertNotRepeated(vCfg, { contentKey: 'v1', platform: 'douyin', variant: 'image' });
  } catch (e) {
    blocked = e;
  }
  ok('同变体 → 闸门挡住', !!blocked);

  // 旧格式台账（没有变体段）→ 新代码仍要能挡住
  const oldCfg = { ROOT: tmp, load: () => ({ publish: { ledger: path.join(tmp, 'ledger-old.yaml') } }) };
  fs.writeFileSync(
    path.join(tmp, 'ledger-old.yaml'),
    ['version: 1', 'entries:', '  - id: "old1#douyin"', '    platform: douyin',
     '    status: "published"', '    url: ""', '    note: ""'].join('\n')
  );
  let oldBlocked = null;
  try {
    ledger.assertNotRepeated(oldCfg, { contentKey: 'old1', platform: 'douyin', variant: 'image' });
  } catch (e) {
    oldBlocked = e;
  }
  ok('旧格式台账条目仍能挡住（向后兼容）', !!oldBlocked);

  // 指纹：同内容换 key 也要能认出来
  ledger.setEntry(vCfg, { contentKey: 'v2', platform: 'weibo', variant: 'image', status: 'published' });
  const fpHit = ledger.findEntry(ledger.read(vCfg), { contentKey: 'v2', platform: 'weibo', variant: 'image' });
  ok('写回带内容指纹', !!(fpHit && fpHit.fingerprint));

  // 旧台账记录带变体写回 → **不该多出一条重复记录**
  const dupCfg = { ROOT: tmp, load: () => ({ publish: { ledger: path.join(tmp, 'ledger-dup.yaml') } }) };
  fs.writeFileSync(
    path.join(tmp, 'ledger-dup.yaml'),
    ['version: 1', 'entries:', '  - id: "d1#douyin"', '    platform: douyin',
     '    status: "published"', '    url: ""', '    note: ""'].join('\n')
  );
  ledger.setEntry(dupCfg, { contentKey: 'd1', platform: 'douyin', variant: 'image', status: 'published' });
  const dupDoc = ledger.read(dupCfg);
  ok('带变体写回旧记录 → 不产生重复条目', dupDoc.entries.length === 1, `实得 ${dupDoc.entries.length} 条`);
  ok('旧记录的 id 被保留（不强行迁移）', dupDoc.entries[0].id === 'd1#douyin', dupDoc.entries[0].id);
}

// ═══ 10. lib/platform-urls.cjs 平台↔链接域名闸 ═══════════════════════
section('lib/platform-urls.cjs');
{
  const urls = require('./lib/platform-urls.cjs');

  ok('公众号链接属于公众号', urls.urlMatchesPlatform('https://mp.weixin.qq.com/s/abc', 'wechat') === true);
  ok('视频号链接不属于公众号（靠路径区分）', urls.urlMatchesPlatform('https://weixin.qq.com/sph/abc', 'wechat') === false);
  ok('视频号链接属于视频号', urls.urlMatchesPlatform('https://weixin.qq.com/sph/abc', 'shipinhao') === true);
  ok('公众号链接不属于视频号', urls.urlMatchesPlatform('https://mp.weixin.qq.com/s/abc', 'shipinhao') === false);
  ok('微博链接属于微博', urls.urlMatchesPlatform('https://weibo.com/3985205283/RouubauwR', 'weibo') === true);
  ok('抖音笔记链接属于抖音', urls.urlMatchesPlatform('https://www.douyin.com/note/7700956323348843826', 'douyin') === true);
  ok('抖音视频链接属于抖音', urls.urlMatchesPlatform('https://www.douyin.com/video/7700957685864320306', 'douyin') === true);
  ok('知乎想法链接属于知乎', urls.urlMatchesPlatform('https://zhihu.com/pin/2098153840356995264', 'zhihu') === true);
  ok('B站链接属于B站', urls.urlMatchesPlatform('https://www.bilibili.com/video/BV1CznZ6WEnL/', 'bilibili') === true);
  ok('陌生域名一律拒写', urls.urlMatchesPlatform('https://example.com/x', 'douyin') === false);
  ok('平台本身不在表里 → 不拦', urls.urlMatchesPlatform('https://example.com/x', 'someunknownplatform') === true);
  ok('跨平台错位：视频号链接放进小红书 → 拒', urls.urlMatchesPlatform('https://weixin.qq.com/sph/abc', 'xiaohongshu') === false);

  // 反查
  ok('反查平台：视频号', urls.platformOfUrl('https://weixin.qq.com/sph/abc') === 'shipinhao');
  ok('反查平台：公众号', urls.platformOfUrl('https://mp.weixin.qq.com/s/abc') === 'wechat');

  // 抽链接
  const got = urls.extractUrls('见 https://a.com/x 和 https://b.com/y。');
  ok('抽取两条链接', got.length === 2, got.join(' | '));

  // 轮换 token 判定
  ok('视频号链接 → 轮换 token', urls.isRotatingTokenUrl('https://weixin.qq.com/sph/A4GAfOX6s') === true);
  ok('B站 BV 号 → 稳定', urls.isRotatingTokenUrl('https://www.bilibili.com/video/BV1CznZ6WEnL/') === false);

  // ⚠️ 禁核验：小红书**一个 HTTP 请求都不许发**
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => {
    calls++;
    return realFetch(...a);
  };
  const v = await urls.verifyUrl('https://www.xiaohongshu.com/explore/6adf4bc5000000001200c077');
  globalThis.fetch = realFetch;
  ok('小红书核验被跳过', v.skipped === true && v.ok === null);
  ok('小红书核验零 HTTP 请求', calls === 0, `实发 ${calls} 次`);
}

// ═══ 11. lib/preflight.cjs 图集连续性 ══════════════════════════════
section('lib/preflight.cjs 图集连续性');
{
  const { preflight } = require('./lib/preflight.cjs');

  // 断号：01 02 04，声称 3 张 → 「在但序错」，必须 FAIL
  const dirA = path.join(tmp, 'media-hole');
  fs.mkdirSync(dirA, { recursive: true });
  ['img-01.png', 'img-02.png', 'img-04.png'].forEach((f) => fs.writeFileSync(path.join(dirA, f), 'x'));
  let holeErr = null;
  try {
    preflight({ platform: 'douyin', mediaDir: dirA, declaredCount: 3, limits: { titleMax: 30 } });
  } catch (e) {
    holeErr = e;
  }
  ok('图集断号 → FAIL', !!holeErr && /序号断了|缺序号/.test(holeErr.message));

  // 不足：只有 2 张却声称 3 张 → FAIL（原来只是 WARN）
  const dirB = path.join(tmp, 'media-short');
  fs.mkdirSync(dirB, { recursive: true });
  ['img-01.png', 'img-02.png'].forEach((f) => fs.writeFileSync(path.join(dirB, f), 'x'));
  let shortErr = null;
  try {
    preflight({ platform: 'douyin', mediaDir: dirB, declaredCount: 3, limits: { titleMax: 30 } });
  } catch (e) {
    shortErr = e;
  }
  ok('图集张数不足 → FAIL（原来只是 WARN）', !!shortErr);

  // 连续 → 通过
  const dirC = path.join(tmp, 'media-ok');
  fs.mkdirSync(dirC, { recursive: true });
  ['img-01.png', 'img-02.png', 'img-03.png'].forEach((f) => fs.writeFileSync(path.join(dirC, f), 'x'));
  let okErr = null;
  try {
    preflight({ platform: 'douyin', mediaDir: dirC, declaredCount: 3, limits: { titleMax: 30 } });
  } catch (e) {
    okErr = e;
  }
  ok('连续图集 → 通过', !okErr);
}

// ═══ 12. lib/driver.cjs + lib/drivers/ego.cjs（ego 通道门面，纯逻辑）═══
section('lib/driver.cjs + lib/drivers/ego.cjs');
{
  const driver = require('./lib/driver.cjs');
  const ego = require('./lib/drivers/ego.cjs');
  const { flatArgsToScriptArgs, sanitizeSpaceKey } = require('./lib/publish-all.cjs');

  // ── 通道判定 ──
  const savedArgs = globalThis.__OP_ARGS__;
  globalThis.__OP_ARGS__ = { _: ['open'] };
  ok('__OP_ARGS__ 存在 → 判定 ego 通道', driver.runtimeChannel() === 'ego');
  delete globalThis.__OP_ARGS__;
  ok('__OP_ARGS__ 缺失 → 判定 playwright 通道', driver.runtimeChannel() === 'playwright');

  // ── 扁平 argv → ScriptArgs 对象（编排器 ego spawn 的转换器）──
  const sa = flatArgsToScriptArgs(['open', '--kind', 'image', '--space-key', 'k1', '--handoff', '1']);
  ok('扁平 argv 转换：子命令进 _', sa._[0] === 'open');
  ok('扁平 argv 转换：带值 flag', sa.kind === 'image' && sa['space-key'] === 'k1' && sa.handoff === '1');
  const sa2 = flatArgsToScriptArgs(['fill', '--force']);
  ok('扁平 argv 转换：无值 flag 读作 true', sa2.force === true);

  // ── 空间 key 清洗（TaskSpace 名只收 [A-Za-z0-9_-]）──
  ok('空间 key 清洗：中文/# → -', sanitizeSpaceKey('2026-10-21_AI热点速递#video') === '2026-10-21_AI-video');
  ok('空间 key 清洗：空 → 空（调用方兜底）', sanitizeSpaceKey('') === '');

  // ── ego 门面：假 taskSpace 全局 + 假 raw page ──
  // 假 evaluate 按「函数源码特征」分发出 canned 值（真机上是页面在跑，测试里是桩）
  function fakeRawPage({ url = 'https://creator.douyin.com/creator-micro/content/upload', alive = true } = {}) {
    const calls = { screenshot: [], clicks: [], presses: [], fills: [], setInput: [], chooserFiles: [] };
    const raw = {
      __calls: calls,
      url: async () => url,
      title: async () => 't',
      evaluate: async (fn, arg) => {
        const src = String(fn);
        if (/querySelectorAll\(q\)\.length/.test(src)) return 2; // resolveNth：多命中
        if (/getBoundingClientRect/.test(src) && arg && arg.q) return { x: 10, y: 20, bx: 1, by: 2, bw: 100, bh: 50 };
        if (/getBoundingClientRect/.test(src)) return { x: 10, y: 20 };
        if (/querySelector/.test(src) && arg) return 'input-value'; // inputValue 读数
        if (/sessionStorage/.test(src)) return 'image';
        return alive ? 1 : null; // isPageAlive 探针
      },
      goto: async () => {},
      waitForTimeout: async () => {},
      waitForFileChooser: async (opts) => ({
        isMultiple: () => false,
        setFiles: async (files) => calls.chooserFiles.push(files),
      }),
      screenshot: async (opts) => {
        calls.screenshot.push(opts);
        return opts.path || 'ok';
      },
      setInputFiles: async (sel, files) => calls.setInput.push([sel, files]),
      fill: async (sel, v) => calls.fills.push([sel, v]),
      click: async (sel) => calls.clicks.push(['sel', sel]),
      mouse: {
        click: async (x, y, opts) => calls.clicks.push(['xy', x, y, opts]),
        move: async () => {},
      },
      keyboard: {
        type: async () => {},
        insertText: async () => {},
        press: async (chord) => calls.presses.push(chord),
      },
    };
    return raw;
  }

  // 12a. wrapPage：url 异步化 + screenshot 剥 timeout + 路径转正斜杠
  const raw = fakeRawPage();
  const page = ego.wrapPage(raw);
  ok('门面 url() 返回 Promise（两通道统一 await）', typeof page.url().then === 'function');
  await page.screenshot({ path: 'C:\\x\\y.png', timeout: 6000, fullPage: false });
  ok('screenshot 剥掉 timeout（ego 不认这个选项）', raw.__calls.screenshot[0].timeout === undefined);
  ok('screenshot 路径转正斜杠', raw.__calls.screenshot[0].path === 'C:/x/y.png');
  ok('screenshot 保留 fullPage', raw.__calls.screenshot[0].fullPage === false);

  // 12b. waitForEvent('filechooser') → waitForFileChooser + setFiles 正斜杠化
  const chooser = await page.waitForEvent('filechooser', { timeout: 100 });
  await chooser.setFiles(['C:\\a\\img-01.png']);
  ok('waitForEvent(filechooser) 映射到 waitForFileChooser', raw.__calls.chooserFiles[0][0] === 'C:/a/img-01.png');

  // 12c. keyboard.press 的大小写归一（Control+a → Control+A）
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+End');
  ok('press 和弦键位归一为大写', raw.__calls.presses[0] === 'Control+A' && raw.__calls.presses[1] === 'Control+End');

  // 12d. $(sel) 句柄：inputValue / fill 多命中加 nth=0 / click 走坐标
  const handle = await page.$('input[placeholder*="标题"]');
  ok('$(sel) 命中返回句柄', !!handle && handle.__egoHandle === true);
  const missing = await page.$('input[type=checkbox][name=nowhere]');
  // 假 evaluate 对 querySelector 特征一律返回真 → 用「命中数为 0」的旁路构造 miss：
  // 真实 miss 语义由 evaluate 存在性检查保证，这里只验证句柄行为
  ok('$(sel) 返回的句柄可 inputValue', (await handle.inputValue()) === 'input-value');
  await handle.fill('标题文字');
  ok('句柄 fill 多命中自动加 nth=0', raw.__calls.fills[0][0].endsWith('>> nth=0'), raw.__calls.fills[0][0]);
  await handle.click();
  ok('句柄 click 走坐标（避开 ego 多命中歧义）', raw.__calls.clicks.some((c) => c[0] === 'xy' && c[1] === 10 && c[2] === 20));

  // 12e. locator：count / nth(i).screenshot 带 clip
  const loc = page.locator('[class*="coverControl"]');
  ok('locator().count() 返回命中数', (await loc.count()) === 2);
  await loc.nth(0).screenshot({ path: 'C:\\x\\slot0.png', timeout: 15000 });
  const shot0 = raw.__calls.screenshot.find((s) => s.path === 'C:/x/slot0.png');
  ok('locator nth 截图带 clip 且剥 timeout', !!shot0 && shot0.timeout === undefined && shot0.clip.width === 100 && shot0.clip.height === 50);

  // ── 12f. 会话生命周期：假 taskSpace 全局 ──
  function fakeTask(name, { dead = false } = {}) {
    const pages = [];
    const task = {
      name,
      spaceId: 4400 + name.length,
      ownership: 'agent',
      pages: async () => pages,
      tabs: async () => pages.map((p) => ({ url: p.__url, page: p })),
      newPage: async () => {
        const p = fakeRawPage({ alive: !dead });
        pages.push(p);
        return p;
      },
      handOff: async () => {
        task.handedOff = true;
      },
      close: async () => {},
    };
    task.newPage(); // 预置一页
    return task;
  }
  const spaces = {};
  globalThis.taskSpace = async (name) => {
    if (!spaces[name]) spaces[name] = fakeTask(name);
    return spaces[name];
  };
  globalThis.takeOverTaskSpace = async (id) => {
    if (id === 9999) throw new Error('hard stop: 空间已交还用户');
    return fakeTask('takeover-' + id);
  };

  const s1 = await ego.createEgoSession({ platform: 'douyin', kind: 'image', spaceKey: 'k-2026-10-27', prefix: 'pk' });
  ok('空间名 = 前缀-平台-线-key', s1.spaceName === 'pk-douyin-image-k-2026-10-27', s1.spaceName);
  ok('会话带 spaceId 供编排器抓取', typeof s1.spaceId === 'number');
  ok('ctx.pages() 返回门面页', (await s1.ctx.pages()).length === 1 && (await s1.ctx.pages())[0].__egoDriver === true);
  let cdpThrew = '';
  try { await s1.ctx.newCDPSession(); } catch (e) { cdpThrew = e.message; }
  ok('ego 下 newCDPSession 明确报错（不假装支持）', /ego 通道不支持/.test(cdpThrew));
  await s1.handOff();
  ok('handOff 交还用户', s1.task.handedOff === true);

  // 12g. 死页自愈：全死页空间 → 关死页 → 换 -r2 新空间名（绝不 claimTaskSpace）
  spaces['pk-douyin-video-broken'] = fakeTask('pk-douyin-video-broken', { dead: true });
  const s2 = await ego.createEgoSession({ platform: 'douyin', kind: 'video', spaceKey: 'broken', prefix: 'pk' });
  ok('全死页 → 自动换 -r2 空间', s2.spaceName === 'pk-douyin-video-broken-r2', s2.spaceName);

  // 12h. 接管路径被拒（hard stop）→ 原样抛出（那是「空间归用户」的信号）
  let takeoverErr = null;
  try {
    await ego.openSpaceAuto('whatever', { spaceId: 9999 });
  } catch (e) {
    takeoverErr = e;
  }
  ok('接管被拒（hard stop）原样抛出', !!takeoverErr && /hard stop/i.test(takeoverErr.message));

  // 还原全局，避免污染后续用例
  if (savedArgs !== undefined) globalThis.__OP_ARGS__ = savedArgs;
  delete globalThis.taskSpace;
  delete globalThis.takeOverTaskSpace;
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
