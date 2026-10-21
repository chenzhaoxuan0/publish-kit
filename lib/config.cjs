// lib/config.cjs — 配置读取与「无静默默认」契约
//
// 这个文件是整个工具集的契约层。核心约定只有一条：
//
//   留空 = 跳过 + 告警，永远不是「猜一个默认值替你填上」。
//
// 为什么要这么死板：填单脚本的终点是「停在发布按钮前让用户点」，
// 如果脚本自己猜了一个分区/分类/合集名填上去，用户在发布前不一定会发现，
// 结果就是一条带着错误分类的内容已经发出去了。
// 留空时控制台的告警是给用户的一次明确提醒，成本远低于发错。
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.yaml');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.yaml');

// 展开 ~ 与环境变量，Windows 路径照常处理
function expand(p) {
  if (!p || typeof p !== 'string') return p;
  let out = p.trim();
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(process.env.HOME || process.env.USERPROFILE || '', out.slice(1));
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] || m);
  return out;
}

let cached = null;

function load({ reload = false } = {}) {
  if (cached && !reload) return cached;
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new ConfigMissing(
      `找不到 config.yaml。\n` +
      `  预期位置：${CONFIG_PATH}\n` +
      `  先跑一次初始化：  node bin/init.cjs\n` +
      `  或手动复制：      node -e "require('fs').copyFileSync('config.example.yaml','config.yaml')"`
    );
  }
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch (e) {
    throw new Error(`config.yaml 解析失败（第 ${e.linePos?.[0]?.line ?? '?'} 行附近）：${e.message}`);
  }
  cached = {
    root: ROOT,
    path: CONFIG_PATH,
    raw: doc,
    runtime: doc.runtime || {},
    content: doc.content || {},
    publish: doc.publish || {},
    platforms: doc.platforms || {},
  };
  return cached;
}

class ConfigMissing extends Error {}

function exists() {
  return fs.existsSync(CONFIG_PATH);
}

// ── 运行时 ────────────────────────────────────────────────
function cdpUrl() {
  const c = load();
  return (c.runtime.cdp_url || 'http://127.0.0.1:39223').trim().replace(/\/$/, '');
}

function chromePath() {
  const v = load().runtime.chrome_path;
  return v ? expand(v) : '';
}

function profileDir() {
  const v = load().runtime.profile_dir || '~/.publish-profile';
  return expand(v);
}

function screenshotDir() {
  const v = load().publish.screenshot_dir || './screenshots';
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

/**
 * 发布台账路径（**可选**）。
 * 配了 = 启用「防重复发布」闸门 + 写回记录；**没配 = 完全不影响现有用法**（不创建任何文件）。
 * 详见 lib/ledger.cjs。
 */
function ledgerPath() {
  const v = load().publish.ledger;
  if (!v) return '';
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

/** 每平台运行日志目录（可选；默认 ./logs） */
function logDir() {
  const v = load().publish.log_dir || './logs';
  return path.isAbsolute(v) ? v : path.join(ROOT, v);
}

function declareAi() {
  const v = load().publish.declare_ai;
  return v === undefined ? true : !!v;
}

function contentDomain() {
  return (load().content.domain || '').trim();
}

// ── 平台 ──────────────────────────────────────────────────
const PLATFORM_KEYS = ['douyin', 'bilibili', 'zhihu', 'weibo', 'shipinhao', 'wechat'];

function platform(name) {
  const c = load();
  return c.platforms[name] || {};
}

function enabled(name) {
  return platform(name).enabled === true;
}

function enabledList() {
  return PLATFORM_KEYS.filter(enabled);
}

/**
 * 取一个平台字段的**字符串**值。
 *
 * 返回值可能是 '' —— 这是刻意的，调用方必须自己决定怎么处理：
 *   跳过该字段 + console.warn 提示用户手填；或者在配置缺失时直接 FATAL。
 * 这个函数永远不会返回内置默认值。
 *
 * ⚠️ 只能用于字符串字段（合集名、分区名、领域名…）。
 *    布尔字段一律用 bool()：本函数对 false 会返回字符串 'false'，
 *    而非空字符串在 JS 里是真值，`if (cfg.hint(k, 'x'))` 会把「关」读成「开」。
 */
function hint(name, key) {
  const v = platform(name)[key];
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') {
    throw new TypeError(
      `config.platforms.${name}.${key} 是布尔字段，请用 bool() 读取，不要用 hint()。`
    );
  }
  return String(v).trim();
}

/**
 * 取一个平台字段的布尔值。
 *
 * 为什么要单独一个函数：hint() 对 false 会返回字符串 'false'，而 'false' 在 JS 里
 * 是真值 —— `if (cfg.hint(k, 'x'))` 会把「关闭」读成「开启」，且不会报任何错。
 * 这类静默反转比崩溃难查得多，所以在这里强制分流。
 *
 * 未配置时返回 def（默认 false），返回 false 表示「这项不做」。
 */
function bool(name, key, def = false) {
  const raw = platform(name)[key];
  if (raw === undefined || raw === null || raw === '') return def;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'n'].includes(s)) return false;
  if (['true', '1', 'yes', 'on', 'y'].includes(s)) return true;
  return def;
}

/**
 * 取一个平台字段值，没配就 FATAL（用于「没有它这条线根本没法发」的必填项，如公众号凭证）。
 */
function hintOrFail(name, key, label) {
  const v = hint(name, key);
  if (!v) {
    throw new Error(
      `配置缺失：platforms.${name}.${key}（${label}）为空。\n` +
      `  这一项没有默认值，也不会替你猜。\n` +
      `  补法：node bin/init.cjs 重新走一遍，或直接编辑 ${CONFIG_PATH}`
    );
  }
  return v;
}

// ── 告警 ──────────────────────────────────────────────────
const warned = new Set();

/** 统一的「留空跳过」告警，同一条只提醒一次，避免刷屏。 */
function warnSkipped(name, key, label) {
  const id = `${name}.${key}`;
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(
    `⚠  跳过 ${label}（platforms.${name}.${key} 未配置）—— 已在发布页留空，发布前请手动选择。\n` +
    `   补法：编辑 ${CONFIG_PATH}，或跑 node bin/init.cjs 重新生成。`
  );
}

module.exports = {
  ROOT,
  CONFIG_PATH,
  EXAMPLE_PATH,
  ConfigMissing,
  load,
  exists,
  expand,
  cdpUrl,
  chromePath,
  profileDir,
  screenshotDir,
  ledgerPath,
  logDir,
  declareAi,
  contentDomain,
  platform,
  enabled,
  enabledList,
  hint,
  bool,
  hintOrFail,
  warnSkipped,
  PLATFORM_KEYS,
};
