// lib/ledger.cjs — 可选发布台账 + 防重复发布闸门
//
// ## 为什么需要
//
// 「绝不重复发布」是本工具的第一红线。但光靠**页面态**判据（页面上有残留文字就拦）
// 只能挡住「同一个标签页还没关」的情况，挡不住这些：
//   · 昨天发过这一期，今天又跑一遍 → **重复发布**
//   · 填完交割给你了（你还没点发布），脚本又跑一遍 → **表单被覆盖，你之前填的没了**
//   · 上次跑到一半失败，重跑时不知道哪些已经成功了 → 重复发
//
// 台账解决的是**跨进程、跨期**的「这条内容发过没有」。
//
// ## 为什么是「可选」
//
// publish-kit 是**通用填单工具**，不是某个项目的发布流水线。
// 所以：config.yaml 里配了 `publish.ledger` 路径才启用，没配就完全不影响现有用法。
// **不配 = 零行为变化**（连文件都不创建）。
//
// ## 台账格式（YAML，人可读、可手改）
//
//   version: 1
//   entries:
//     - id: "2026-10-21_AI热点速递卡片#video"
//       platform: douyin
//       status: manual-handoff        # pending | manual-handoff | published | failed | skipped
//       url: ""                        # 发布后的链接（可后补）
//       note: ""
//       updated: "2026-10-21T21:30:00.000Z"
//
// status 的语义与「交割护栏」的关系：
//   pending          —— 没动过，可以填
//   manual-handoff   —— 已填完交割给你，等你点发布 → **挡住**（除非显式 allowRepeat）
//   published        —— 已发布 → **挡住**（除非显式 allowRepeat）
//   failed           —— 上次失败 → 告警后允许重试
//   skipped          —— 跳过 → 允许
//
// ## ⚠️ 写回不能静默丢记录
//
// 「找不到目标记录就 return 掉了事」是隐蔽的坑：闸门对这条记录失效、总览里也看不到它，
// 而表面上一切正常。→ 找不到记录时报错或**新建**，绝不静默吞掉。

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const crypto = require('crypto');

const STATUS = {
  PENDING: 'pending',
  MANUAL_HANDOFF: 'manual-handoff',
  PUBLISHED: 'published',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/** 挡住重填的两种状态 */
const BLOCKING = [STATUS.MANUAL_HANDOFF, STATUS.PUBLISHED];

function ledgerPath(cfg) {
  const v = cfg.load().publish.ledger;
  if (!v) return '';
  return path.isAbsolute(v) ? v : path.join(cfg.ROOT, v);
}

/** 读台账（没有配置 → 返回 null，表示「台账未启用」） */
function read(cfg) {
  const p = ledgerPath(cfg);
  if (!p) return null;
  if (!fs.existsSync(p)) return { version: 1, entries: [], _path: p };
  try {
    const doc = YAML.parse(fs.readFileSync(p, 'utf8')) || {};
    doc.entries = Array.isArray(doc.entries) ? doc.entries : [];
    doc._path = p;
    return doc;
  } catch (e) {
    throw new Error(`台账解析失败（${p}）：${e.message}\n  台账是人可读的事实源，别手工改坏；修不了就把它挪走再重跑。`);
  }
}

/** 写台账（原子写：先写临时文件再 rename，避免写一半断电留半个文件） */
function write(cfg, doc) {
  const p = ledgerPath(cfg);
  if (!p) return null;
  const clean = { version: doc.version || 1, entries: doc.entries || [] };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, YAML.stringify(clean), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

/** 条目 id（幂等键） */
function makeId(contentKey, platform) {
  return `${contentKey}#${platform}`;
}

/** 找条目 */
function find(doc, id) {
  if (!doc) return null;
  return (doc.entries || []).find((e) => e.id === id) || null;
}

/**
 * 防重复闸门：**起浏览器之前**查台账。
 *
 * @param {Object} cfg 配置层
 * @param {Object} o
 * @param {string} o.contentKey 内容标识（如 "2026-10-21_AI热点速递卡片#video"）
 * @param {string} o.platform 平台 key
 * @param {boolean} [o.allowRepeat] 显式允许重复
 * @returns {Object} {enabled, hit, allowed, reason}
 *   enabled=false 表示台账未启用 → 一律放行
 */
function assertNotRepeated(cfg, { contentKey, platform, allowRepeat = false }) {
  const doc = read(cfg);
  if (!doc) return { enabled: false, hit: null, allowed: true, reason: '台账未启用' };

  const id = makeId(contentKey, platform);
  const hit = find(doc, id);
  if (!hit) return { enabled: true, hit: null, allowed: true, reason: '台账里没有这条记录' };

  if (!BLOCKING.includes(hit.status)) {
    return { enabled: true, hit, allowed: true, reason: `上次状态=${hit.status}（不挡）` };
  }
  if (allowRepeat) {
    console.warn(
      `⚠ 台账里这条已是 ${hit.status}（${hit.url || '无链接'}），但指定了 allowRepeat → 继续`
    );
    return { enabled: true, hit, allowed: true, reason: 'allowRepeat' };
  }
  const err = new Error(
    `[防重复闸门] 这条内容在 ${platform} 已是 **${hit.status}**` +
      (hit.url ? `（${hit.url}）` : '') +
      `，不能重新填单。\n` +
      `  确需重发请显式加 --allow-repeat。\n` +
      `  台账：${doc._path}`
  );
  err.ledgerBlock = { id, status: hit.status };
  throw err;
}

/**
 * 写回一条记录。
 * ⚠️ **找不到就新建，绝不静默丢** —— 静默丢会让闸门对这条记录失效。
 *
 * @param {Object} cfg
 * @param {Object} o {contentKey, platform, status, url, note}
 * @returns {Object} 写入的条目
 */
function setEntry(cfg, { contentKey, platform, status, url = '', note = '' }) {
  const doc = read(cfg);
  if (!doc) return null; // 台账未启用 → 不写
  const id = makeId(contentKey, platform);
  const entries = doc.entries || [];
  const idx = entries.findIndex((e) => e.id === id);
  const rec = {
    id,
    platform,
    status,
    url: url || (idx >= 0 ? entries[idx].url || '' : ''),
    note: note || (idx >= 0 ? entries[idx].note || '' : ''),
    updated: new Date().toISOString(),
  };
  if (idx >= 0) entries[idx] = rec;
  else entries.push(rec);
  doc.entries = entries;
  write(cfg, doc);
  return rec;
}

/** 内容指纹（幂等键的备选：同内容不同期也能识别） */
function fingerprint(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
}

module.exports = {
  STATUS,
  BLOCKING,
  ledgerPath,
  read,
  write,
  makeId,
  find,
  assertNotRepeated,
  setEntry,
  fingerprint,
};
