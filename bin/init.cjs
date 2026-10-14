#!/usr/bin/env node
// bin/init.cjs — 首次配置向导
//
// 解决的问题：这工具原本把「B站分区=人工智能 / 微博分类=科技数码 / 知乎领域=科技互联网」
// 写死在脚本里，于是只对发 AI 科技内容的人开箱即用，换个领域就是错的。
// 这里改成：问一次你的内容领域，给出各平台的建议值并让你确认或改掉。
//
// 关键点——建议值是「明着猜」，不是「暗着填」。你能在写进配置前看到并改掉它，
// 而写死在脚本里的默认值你根本不知道它存在。
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const YAML = require('yaml');
const cfg = require('../lib/config.cjs');

const C_BOLD = '\x1b[1m';
const C_RESET = '\x1b[0m';

// 内容领域 → 各平台分区建议。全部可在向导里改，也可留空让脚本跳过。
// 新增领域就在这里加一条；key 用 slug。
const DOMAIN_PRESETS = {
  'ai': {
    label: 'AI 科技',
    hints: {
      bilibili: { key: 'category_hint', label: 'B站分区', suggest: '人工智能' },
      weibo: { key: 'channel_hint', label: '微博分类', suggest: '科技数码' },
      zhihu: { key: 'field_hint', label: '知乎所属领域', suggest: '科技互联网' },
    },
  },
  'finance': {
    label: '财经',
    hints: {
      bilibili: { key: 'category_hint', label: 'B站分区', suggest: '财经商业' },
      weibo: { key: 'channel_hint', label: '微博分类', suggest: '财经' },
      zhihu: { key: 'field_hint', label: '知乎所属领域', suggest: '财经' },
    },
  },
  'edu': {
    label: '教育',
    hints: {
      bilibili: { key: 'category_hint', label: 'B站分区', suggest: '校园学习' },
      weibo: { key: 'channel_hint', label: '微博分类', suggest: '教育' },
      zhihu: { key: 'field_hint', label: '知乎所属领域', suggest: '教育' },
    },
  },
};

const PLATFORMS = [
  { key: 'douyin', label: '抖音', def: true },
  { key: 'bilibili', label: 'B站', def: true },
  { key: 'zhihu', label: '知乎', def: true },
  { key: 'weibo', label: '微博', def: true },
  { key: 'shipinhao', label: '视频号', def: false },
  { key: 'wechat', label: '公众号（走 API，需凭证）', def: true },
];

function rl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

// ── 输入层 ────────────────────────────────────────────────
//
// 不要用 readline.question() 逐题提问：管道/重定向输入时 stdin 会一次把所有行
// 送进来，readline 在「没有提问挂起」时触发的 line 事件没有接收者，行被直接丢弃。
// 表现是前几个答案能进去、后面全丢，而且纯 ASCII 输入也一样——不是编码问题。
//
// 改成自己收 line 事件 + 队列：没人等的行进队列，等人的取队列，两边都不丢。
let rlClosed = false;

function makeReader(r) {
  const buffered = [];
  const waiters = [];
  r.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else buffered.push(line);
  });
  r.once('close', () => {
    rlClosed = true;
    while (waiters.length) waiters.shift()(null);
  });
  return function next() {
    if (buffered.length) return Promise.resolve(buffered.shift());
    if (rlClosed) return Promise.resolve(null);
    return new Promise((res) => waiters.push(res));
  };
}

let readLine = async () => null;

async function ask(q, def = '') {
  if (rlClosed) return def;
  const suffix = def ? ` [${def}]` : '';
  process.stdout.write(`  ${q}${suffix}: `);
  const ans = await readLine();
  return (ans === null ? '' : String(ans).trim()) || def;
}

async function yesno(q, def) {
  const ans = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'}`, '')).toLowerCase();
  if (!ans) return def;
  return ans === 'y' || ans === 'yes';
}

async function main() {
  const argv = process.argv.slice(2);
  const DRY = argv.includes('--dry-run');
  const r = rl();
  readLine = makeReader(r);
  const out = {};

  console.log('\npublish-kit 首次配置');
  console.log('─'.repeat(60));
  console.log('所有「分区/分类/合集」这类字段，留空 = 脚本不碰它并在控制台提醒你手填。');
  console.log('脚本不会猜一个值替你填上。\n');

  // ── 运行时 ──────────────────────────────────────────────
  console.log('[1/5] 运行环境');
  const cdpPort = await ask('CDP 端口（占用会起不来，Windows 上先查保留段）', '39223');
  out.runtime = {
    cdp_url: `http://127.0.0.1:${cdpPort}`,
    chrome_path: '',
    profile_dir: await ask('专用浏览器 profile 目录（登录态存这里，定下就别移动）', '~/.publish-profile'),
  };

  // ── 内容领域 ────────────────────────────────────────────
  console.log('\n[2/5] 内容领域');
  const slugs = Object.keys(DOMAIN_PRESETS);
  slugs.forEach((s, i) => console.log(`  ${i + 1}) ${DOMAIN_PRESETS[s].label}  (${s})`));
  console.log(`  ${slugs.length + 1}) 其他（不预设，各平台字段全留空由你手填）`);
  const pick = (await ask('你的内容领域是哪个？可输序号或 slug', '1')).trim();
  const slug = /^\d+$/.test(pick) ? slugs[Number(pick) - 1] : pick;
  const preset = DOMAIN_PRESETS[slug] || null;
  out.content = { domain: preset ? preset.label : slug, language: 'zh' };

  console.log(
    preset
      ? `  → 选中「${preset.label}」，下面会按它给各平台分区建议值`
      : '  → 不套用预设，各平台分区/分类/领域将全部留空'
  );

  // ── 启用平台 ────────────────────────────────────────────
  // 注意：这里问出来的开关必须和 platforms 下的字段一一对应上。平台脚本只认
  // config.yaml 里的字段，init 不写某个字段，脚本就永远读到 undefined——
  // 「用户在向导里答了要，脚本却因为字段不存在而不做」是最难自查的一类 bug。
  console.log('\n[3/5] 启用哪些平台');
  out.platforms = {};
  for (const p of PLATFORMS) {
    const on = await yesno(`${p.label}`, p.def);
    out.platforms[p.key] = { enabled: on };
    if (p.key === 'douyin') {
      out.platforms[p.key].album = await ask('    抖音合集名', '');
      // 抖音的自主声明是 platforms.douyin.self_declare 这个独立字段，
      // 不是 publish.declare_ai。不写它，douyin.cjs 读到 undefined 就当 false，
      // 于是用户明明开了声明、抖音这条线却永远不代填。必须显式落这个字段。
      out.platforms[p.key].self_declare = true;
    }
    if (p.key === 'shipinhao') {
      out.platforms[p.key].album = await ask('    视频号合集名', '');
      // 位置是「未经询问就替用户点掉」的开关，同样要问，不能默认 true。
      out.platforms[p.key].hide_location = await yesno('    自动设为「不显示位置」', false);
    }
  }

  // ── 分区/分类/领域 ──────────────────────────────────────
  console.log('\n[4/5] 各平台分区 / 分类 / 领域');
  for (const [pk, spec] of Object.entries(preset ? preset.hints : {})) {
    if (!out.platforms[pk] || !out.platforms[pk].enabled) continue;
    const ans = await ask(`  ${spec.label}（回车=用建议「${spec.suggest}」，输入 '-' = 不填）`, spec.suggest);
    out.platforms[pk][spec.key] = ans === '-' ? '' : ans;
  }
  if (!preset) console.log('  （未套用预设，跳过）');

  // ── 发布策略 + 公众号凭证 ───────────────────────────────
  console.log('\n[5/5] 发布策略');
  out.publish = {
    declare_ai: await yesno('自动勾选「含 AI 生成内容」声明', true),
    screenshot_dir: './screenshots',
  };

  if (out.platforms.wechat && out.platforms.wechat.enabled) {
    console.log('\n  公众号走官方 API，需要你自己的凭证：');
    console.log('  获取路径：mp.weixin.qq.com → 设置与开发 → 基本配置');
    console.log('  另外要把你本机公网 IP 加进「IP 白名单」，否则报 invalid ip。');
    out.platforms.wechat.app_id = await ask('  AppID（回车=稍后再填）', '');
    out.platforms.wechat.app_secret = await ask('  AppSecret（回车=稍后再填）', '');
    out.platforms.wechat.max_images = 20;
  }

  // ── 落盘 ────────────────────────────────────────────────
  const header =
    '# publish-kit 配置（由 node bin/init.cjs 生成）\n' +
    '# 本文件含你的偏好与公众号凭证，已进 .gitignore，不要提交。\n' +
    '# 字段含义见 config.example.yaml\n';
  const text = header + YAML.stringify(out, { lineWidth: 100 });

  r.close();

  if (DRY) {
    console.log('\n' + '─'.repeat(60));
    console.log(`${C_BOLD}--dry-run：以下内容将被写入 config.yaml${C_RESET}\n`);
    console.log(text);
    console.log('未写入任何文件。');
    return;
  }

  const target = cfg.CONFIG_PATH;
  const existed = fs.existsSync(target);
  if (existed) {
    const bak = `${target}.bak`;
    fs.copyFileSync(target, bak);
    console.log(`\n  已备份旧配置 → ${bak}`);
  }
  fs.writeFileSync(target, text, 'utf8');

  console.log('\n' + '─'.repeat(60));
  console.log(`✅ 配置已写入：${target}`);
  const emptyFields = [];
  for (const [k, v] of Object.entries(out.platforms)) {
    if (!v.enabled) continue;
    for (const f of ['category_hint', 'channel_hint', 'field_hint']) {
      if (f in v && !v[f]) emptyFields.push(`platforms.${k}.${f}`);
    }
  }
  if (emptyFields.length) {
    console.log('\n以下字段留空，发布时脚本会跳过并提醒你手填：');
    emptyFields.forEach((f) => console.log(`  · ${f}`));
  }
  console.log('\n下一步：node bin/doctor.cjs   ← 检查浏览器与各平台登录态');
  console.log('      node bin/login.cjs       ← 打开要登录的平台\n');
}

main().catch((e) => {
  console.error('\n配置向导中断：', e.message);
  process.exit(1);
});
