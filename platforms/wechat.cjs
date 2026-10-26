#!/usr/bin/env node
/**
 * wechat.cjs —— 公众号贴图（图片消息 newspic）API 草稿通道
 *
 * 用途：走微信官方 API 把一组图片 + 配文推进公众号草稿箱。
 *   本包三个脚本里只有这一个不经浏览器（另外两个经 CDP 连已登录的浏览器填单），
 *   所以它也没有登录态、没有填单护栏那一套，只有凭证与出口 IP 两件事要照看。
 *
 * 契约：只推草稿箱，绝不调用任何发布类 API（freepublish / 群发）。
 *   「发布」必须由用户在 mp.weixin.qq.com 后台人工点击。
 *   个人主体账号的 freepublish/群发 API 权限已于 2025-07 被微信官方回收，也无认证通道，
 *   所以本脚本不去碰那些接口：宁可停在草稿箱，也不留一条能误触群发的代码路径。
 *
 * 本工具不对特定平台做自动化；是否接入某平台由使用者自行判断并承担后果。
 *
 * 用法：
 *   node platforms/wechat.cjs ip                    # 查当前公网出口 IP，与上次记录比对；变化即提示去后台改白名单（不取 token、不依赖凭证）
 *   node platforms/wechat.cjs check                 # 连通性检查（先比对出口 IP，再取 token，无写入）
 *   node platforms/wechat.cjs verify --media-id <草稿 media_id>
 *                    # **只读**核查：这条草稿到底在不在草稿箱里（只调 draft/get / draft/batchget，不碰任何写入接口）
 *   node platforms/wechat.cjs push --media <图片目录> --title "<标题 ≤32 字>"
 *                    [--body-file <纯文本正文>] [--count N] [--app-id <appId>]
 *                    [--material-ids "<id1,id2,...>"] [--content-key <key>] [--variant <v>] [--allow-repeat]
 *
 * verify 的机器可读输出（编排层按这一行 + 退出码判断，**别改格式**）：
 *   DRAFT_VERIFY: ok media_id=<id> title=<标题>      退出码 0  → 草稿在
 *   DRAFT_VERIFY: not_found media_id=<id>             退出码 1  → 草稿不在
 *   DRAFT_VERIFY: error media_id=<id> reason=<原因>   退出码 2  → 核查本身出错（凭证/接口），
 *                                                     **≠「不存在」**，别拿它当「没落库」去重传素材
 *
 * push 的机器可读输出（编排层按这两行取素材与草稿 id，**别改格式**）：
 *   MATERIAL_IDS: <逗号分隔的 media_id>   ← 上传完成**立刻**打印（draft/add 失败时也拿得到 → 可据此重建）
 *   DRAFT_MEDIA_ID: <草稿 media_id>       ← 草稿真的进箱之后才打印
 *
 * --material-ids：复用**已经上传过的**永久素材重建草稿（不再上传 → 不再白占一份素材库配额）。
 *   传了就必须与「本次要贴的图数」一致，不一致直接 FATAL —— 绝不「能贴几张贴几张」。
 *   ⚠️ id 的顺序必须与 listImages 的排序一致（cover 类最先、编号其次、end 类最后，首张即封面）。
 *
 * --content-key：内容标识。配了 publish.ledger 时走**防重复闸门**（同一条内容不重复推草稿）。
 *   闸门在**上传任何素材之前**拦下 → 被拦时一个素材都不上传。
 *   没配台账 / 没传 --content-key → 零行为变化。
 * --variant：台账里的分发变体（可选）。不传就按 'image' / 'default' / 旧格式三种都查
 *   ——公众号只有图文一条线，任何变体下记着「已发过」都该拦。
 *
 * 凭证（按顺序，环境变量优先）：
 *   1. 环境变量 WECHAT_APP_ID / WECHAT_APP_SECRET
 *   2. config.yaml 的 platforms.wechat.app_id / app_secret
 *      —— 必填项，没配直接报错并给出补法。脚本不猜，也不会去别的目录翻凭证文件。
 *      获取：mp.weixin.qq.com → 设置与开发 → 基本配置
 *
 * 出口 IP 记录：与 config.yaml 同目录的 wechat-ip.json（last_ip + 变更历史，最近 20 条）。
 *   这是本地运行状态文件（内含公网 IP），仓库应把它排除在版本控制之外。
 *   家宽动态 IP 场景：任务开始先跑 ip 子命令；IP 变了用户可并行去后台改白名单，
 *   之后回来重试 check/push（白名单改动 5-10 分钟生效）。
 *
 * 图片约定：
 *   .png/.jpg，排除 *_blank*；顺序 = cover 类文件最先、编号卡其次、end 类最后（自然排序）；
 *   newspic 单条上限 20 张（微信平台限制，可用 platforms.wechat.max_images 覆盖），首张即封面。
 *
 * 返回：草稿 media_id（机器可读行 MATERIAL_IDS / DRAFT_MEDIA_ID）。
 *   「发布」是人工动作，发布成功后自行回填你的发布记录。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config.cjs');
const ledger = require('../lib/ledger.cjs');

const API = 'https://api.weixin.qq.com';
const TITLE_MAX = 32; // newspic 标题上限（微信平台限制，官方：总长度不超过32个字）
const BODY_WARN = 1100; // 贴图配文建议上限（超过仅告警，不阻断）
// newspic content 实测硬上限（经二分实测确定：1265 字通过 / 1266 字失败 → errcode 45166
// "invalid content hint"）。官方文档写的是 2 万字符，那是普通图文类型的上限；
// newspic 贴图类型的 content 会被服务端额外限制，超限一律报 45166 且 errmsg 不给具体阈值。
// 这里留 30 字余量，避免中英混排时按 code point 计数与字节计数的差异踩线。
const BODY_MAX = 1265;

// newspic 单条图片数上限：微信平台限制为 20 张。
// 写成函数而不是顶层常量：`ip` 子命令不取 token、不读凭证，也不该要求 config.yaml 完整可用。
// 这里的 20 不是猜的业务默认值，是平台写死的限制；配置项只允许往下收（截图更少），
// 真正超限会被 listImages 的报错挡住。
function maxImages() {
  return parseInt(cfg.hint('wechat', 'max_images'), 10) || 20;
}

// 公网出口 IP 记录与探测：家宽动态 IP 场景，白名单只认单个 IPv4（不支持网段/域名，
// 条数上限很小），IP 变了只能后台人工改，故本地记录 + 任务开始时主动提醒。
// 落在 config.yaml 同目录（package 根），不引用任何外部数据目录。
const IP_FILE = path.join(cfg.ROOT, 'wechat-ip.json');
const IP_ECHOES = [
  'https://myip.ipip.net',        // 国内可达性最好，返回中文文本，用正则提取
  'https://ipv4.icanhazip.com',   // Cloudflare 运营，纯 IP
  'https://api.ipify.org',        // 兜底
];
const IPV4_RE = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

// verify 子命令的错误出口上下文：置上之后 fail() 改走机器可读行 + 退出码 2。
// 为什么单独一条通道：verify 的退出码有语义（0=在 / 1=不在 / 2=核查出错），
// 若凭证或接口出错也用 1，编排层会把「查不动」误判成「草稿不在」→ 白重传一遍素材。
let _verifyCtx = null;

const fail = (msg) => {
  if (_verifyCtx) {
    // 这一行是 verify 唯一的产出 → 直接 exit，调用方（fail 的所有调用点）都假设它不返回。
    // 截断风险：管道写是异步的，但**单行短文本**在 libuv 里会一次写完（远小于管道缓冲），
    // 真正会截半的是多行大输出 —— 那条路径（push）已经改用 finish() 自然退出。
    console.log(`DRAFT_VERIFY: error media_id=${_verifyCtx.mediaId} reason=${oneLine(msg)}`);
    process.exit(2);
  }
  console.error('❌ ' + msg);
  process.exit(1);
};

const ok = (msg) => console.log('✅ ' + msg);

/** 多行压成一行（机器可读输出必须只有一行） */
function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * 收尾退出：先设 exitCode，让 stdout 冲干净再自然结束。
 * ⚠️ 不要在这里直接 process.exit()：
 *    ① Windows 上**管道写是异步的** → 立即退出会把机器可读行
 *       （DRAFT_VERIFY / MATERIAL_IDS / DRAFT_MEDIA_ID）截半，编排层就解析不出来。
 *    ② 立即退出会打断 keep-alive 句柄 → Windows 上触发 libuv 断言
 *       （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)）→ 退出码被污染成 0xC0000409。
 * 定时器是兜底（万一事件循环被什么吊住），unref 不拖住正常退出。
 */
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 12000).unref();
}

// 布尔开关：不吃下一个参数（`--allow-repeat` 后面跟的是别的参数，不能被吞掉）
const BOOL_FLAGS = new Set(['allow-repeat']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) args[a.slice(2, eq)] = a.slice(eq + 1);          // --key=value
      else if (BOOL_FLAGS.has(a.slice(2))) args[a.slice(2)] = true; // --flag
      else args[a.slice(2)] = argv[++i];                           // --key value
    }
    else args._.push(a);
  }
  return args;
}

/**
 * 凭证解析：环境变量优先，其次 config.yaml。两处都没有就 FATAL——
 * 这是必填凭证，没有它这条线根本发不出去，所以明确报错比「留空跳过」更合适。
 * 顺带支持 --app-id 临时换一个 AppID（配对 secret 仍取自配置）。
 */
function loadCredential(appIdArg) {
  if (process.env.WECHAT_APP_ID && process.env.WECHAT_APP_SECRET) {
    return { appId: process.env.WECHAT_APP_ID, appSecret: process.env.WECHAT_APP_SECRET, source: '环境变量 WECHAT_APP_ID/SECRET' };
  }
  const appId = appIdArg || cfg.hintOrFail('wechat', 'app_id', '公众号 AppID');
  const appSecret = cfg.hintOrFail('wechat', 'app_secret', '公众号 AppSecret');
  return { appId, appSecret, source: 'config.yaml platforms.wechat' };
}

async function fetchPublicIP() {
  for (const url of IP_ECHOES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const m = (await res.text()).match(IPV4_RE);
      if (m) return m[1];
    } catch (_) { /* 换下一个探测源 */ }
  }
  return null;
}

/**
 * 出口 IP 预检：查当前公网 IP 并与上次记录比对，变化即提示用户去后台改白名单。
 * 记录写 config.yaml 同目录的 wechat-ip.json。探测失败只警告不阻塞（后续 token 步骤仍会兜底拦截）。
 * 返回 { ip, last, changed }；探测失败返回 null。
 */
async function ipPreflight() {
  const ip = await fetchPublicIP();
  if (!ip) {
    console.warn('⚠ 无法获取当前公网出口 IP（探测源均超时），跳过比对；若推送报 invalid ip 请按错误提示处理。');
    return null;
  }
  let rec = {};
  try { rec = JSON.parse(fs.readFileSync(IP_FILE, 'utf8')); } catch (_) { /* 首次无记录 */ }
  const last = rec.last_ip || '';
  const changed = !!last && last !== ip;
  if (ip !== last) {
    const history = Array.isArray(rec.history) ? rec.history : [];
    if (last) history.unshift({ from: last, to: ip, at: new Date().toISOString() });
    fs.writeFileSync(IP_FILE, JSON.stringify({
      last_ip: ip, checked_at: new Date().toISOString(), history: history.slice(0, 20),
    }, null, 2) + '\n');
  }
  if (!last) {
    console.log(`ℹ️ 首次记录公网出口 IP：${ip}（记录文件 ${IP_FILE}）`);
    console.log('   请确认公众号后台「设置与开发-基本配置-IP白名单」已含该 IP。');
  } else if (!changed) {
    console.log(`✅ 公网出口 IP 未变：${ip}`);
  } else {
    console.warn(`⚠⚠ 公网出口 IP 已变化：${last} → ${ip}`);
    console.warn(`   请去公众号后台「设置与开发-基本配置-IP白名单」删除旧条目、加入 ${ip}（改动 5-10 分钟生效）。`);
    console.warn('   可先继续其他任务，白名单生效后再回来重试 check/push。');
  }
  return { ip, last, changed };
}

async function getToken(appId, appSecret) {
  const res = await fetch(`${API}/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`, { signal: AbortSignal.timeout(30000) });
  const j = await res.json();
  if (!j.access_token) {
    if (j.errcode === 40164) fail(`invalid ip：本机公网 IP 不在公众号白名单。后台「设置与开发-基本配置-IP白名单」加入当前 IP（错误信息里有具体 IP）后重试，改动 5-10 分钟生效；也可先跑 node platforms/wechat.cjs ip 查看当前出口 IP。（${j.errmsg || ''}）`);
    if (j.errcode === 40125 || j.errcode === 40013) fail(`凭证无效（errcode=${j.errcode}）：检查 AppID/AppSecret 是否正确。`);
    fail(`获取 access_token 失败：${JSON.stringify(j)}`);
  }
  return j.access_token;
}

function listImages(mediaDir, count) {
  if (!mediaDir || !fs.existsSync(mediaDir)) fail(`--media 目录不存在：${mediaDir}`);
  const groupOf = (n) => (/cover/i.test(n) ? 0 : /end/i.test(n) ? 2 : 1);
  const nat = (s) => s.replace(/\d+/g, (m) => m.padStart(6, '0'));
  let files = fs.readdirSync(mediaDir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f) && !_blank(f))
    .sort((a, b) => groupOf(a) - groupOf(b) || nat(a).localeCompare(nat(b)));
  function _blank(f) { return /_blank/i.test(f); }
  if (count) files = files.slice(0, count);
  if (!files.length) fail(`目录里没有可用图片（.png/.jpg，排除 *_blank）：${mediaDir}`);
  const max = maxImages();
  if (files.length > max) fail(`图片 ${files.length} 张超过 newspic 上限 ${max} 张，用 --count 截取或拆分。`);
  return files.map((f) => path.join(mediaDir, f));
}

async function uploadImage(token, file, retry = true) {
  const form = new FormData();
  form.append('media', new Blob([fs.readFileSync(file)], { type: 'image/png' }), path.basename(file));
  const res = await fetch(`${API}/cgi-bin/material/add_material?access_token=${token}&type=image`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  const j = await res.json();
  if (!j.media_id) {
    if (j.errcode === 40001 && retry) return uploadImage(await refreshToken(), file, false);
    fail(`上传永久素材失败 ${path.basename(file)}：${JSON.stringify(j)}`);
  }
  return j.media_id;
}

async function pushDraft(token, { title, content, mediaIds }) {
  const body = {
    articles: [{
      article_type: 'newspic',
      title,
      content,
      need_open_comment: 0,
      only_fans_can_comment: 0,
      image_info: { image_list: mediaIds.map((image_media_id) => ({ image_media_id })) },
    }],
  };
  const res = await fetch(`${API}/cgi-bin/draft/add?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return res.json();
}

// ── 草稿核查（只读）────────────────────────────────────────────────────
// draft/batchget 单页条数（微信限制 20）
const DRAFT_PAGE = 20;
// draft/batchget 兜底扫描的最大页数（20×10 = 200 条草稿）
const DRAFT_SCAN_PAGES = 10;

/**
 * 从 draft/get 的返回里取标题。
 *
 * ⚠️ 官方文档里 draft/get 的返回结构有两种写法（顶层直接是文章字段，
 *    或 news_item 数组），batchget 的 item 又是「content.news_item」——
 *    三种形状都兜住，避免「有内容但取不到标题」被误判成「不存在」。
 */
function draftTitle(j) {
  if (!j || typeof j !== 'object') return '';
  const items = Array.isArray(j.news_item)
    ? j.news_item
    : (j.content && Array.isArray(j.content.news_item) ? j.content.news_item : null);
  if (items && items.length) return oneLine(items[0].title || '');
  if (typeof j.title === 'string' && j.title) return oneLine(j.title);
  return '';
}

/**
 * 兜底：扫草稿箱列表找这条草稿（**只读**）。
 *
 * 为什么要有兜底：draft/get 对「不存在的 media_id」返回的是 **errcode**（如 40007）而不是空结果，
 * 直接把 errcode 当成「不存在」会有假阴性 → 编排层以为草稿没落库 → 重新上传一遍素材
 * → 白占一份永久素材配额（而素材进库了只能去后台人工删）。所以 errcode 之后必须再扫一遍列表
 * 才敢下「not_found」的结论。
 *
 * ⚠️ 分页字段别搞混（官方文档）：
 *   total_count = 草稿**总数**；item_count = **本次调用返回的条数**（页大小，不是总数）。
 *   拿 item_count 当总数 → 扫完第一页就停 → 排在后面的草稿永远找不到（假阴性）。
 */
async function scanDrafts(token, mediaId) {
  let offset = 0;
  for (let page = 0; page < DRAFT_SCAN_PAGES; page++) {
    const res = await fetch(`${API}/cgi-bin/draft/batchget?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, count: DRAFT_PAGE, no_content: 1 }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json();
    if (j.errcode) return { error: `draft/batchget 失败：${JSON.stringify(j)}` };
    const items = Array.isArray(j.item) ? j.item : [];
    // 官方 draft/batchget 的 item 里，草稿 id 字段是 media_id（有的版本叫 item_id，两种都认）
    const hit = items.find((it) => it && (it.media_id === mediaId || it.item_id === mediaId));
    if (hit) return { found: true, title: draftTitle(hit) };
    const total = typeof j.total_count === 'number' ? j.total_count : 0;
    offset += items.length;
    if (!items.length || (total && offset >= total)) return { found: false };
  }
  return { found: false, truncated: true }; // 扫到上限还没找到 → 不敢下结论
}

/**
 * 查这条草稿在不在草稿箱里。
 * **只读**：只调 draft/get 与 draft/batchget，不碰任何上传/写入接口，不新增素材。
 * @returns {Promise<{found:boolean, title?:string, error?:string}>}
 */
async function findDraft(token, mediaId) {
  const res = await fetch(`${API}/cgi-bin/draft/get?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: mediaId }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  const hasContent =
    (Array.isArray(j && j.news_item) && j.news_item.length > 0) ||
    (j && j.content && Array.isArray(j.content.news_item) && j.content.news_item.length > 0) ||
    (j && typeof j.title === 'string' && j.title.length > 0);
  if (hasContent) return { found: true, title: draftTitle(j) };
  const scan = await scanDrafts(token, mediaId);
  if (scan.error) return { error: scan.error };
  if (scan.truncated) {
    return { error: `草稿箱超过 ${DRAFT_SCAN_PAGES * DRAFT_PAGE} 条，未扫全，无法确认这条草稿是否存在` };
  }
  return { found: false };
}

/**
 * 解析 --material-ids "<id1,id2,...>" → id 数组（保持传入顺序 = 贴图顺序）。
 */
function parseMaterialIds(raw) {
  const ids = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids;
}

let _cred = null;
let _token = null;
async function currentToken() {
  if (!_token) _token = await getToken(_cred.appId, _cred.appSecret);
  return _token;
}
async function refreshToken() { _token = null; return currentToken(); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  // ip 子命令：纯本地出口 IP 比对，不取 token、不需要凭证——任务最早期就能跑，
  // IP 变化时 exit 2，方便自动化流程识别后先去提醒用户。
  // 注意用 exitCode 自然退出：立即 process.exit 会打断 keep-alive 句柄，
  // 在 Windows 上触发 libuv 断言把退出码污染成 127。
  if (cmd === 'ip') {
    const r = await ipPreflight();
    if (!r) { process.exitCode = 1; return; }
    process.exitCode = r.changed ? 2 : 0;
    setTimeout(() => process.exit(process.exitCode || 0), 15000).unref();
    return;
  }

  if (!cmd || !['check', 'push', 'verify'].includes(cmd)) {
    console.log(
      '用法：\n' +
      '  node platforms/wechat.cjs ip\n' +
      '  node platforms/wechat.cjs check\n' +
      '  node platforms/wechat.cjs verify --media-id <草稿 media_id>   # 只读核查草稿在不在\n' +
      '  node platforms/wechat.cjs push --media <图片目录> --title "<标题 ≤32 字>" [--body-file <纯文本>] [--count N] [--app-id <appId>]\n' +
      '                    [--material-ids "<id1,id2,...>"] [--content-key <key>] [--variant <v>] [--allow-repeat]'
    );
    process.exit(cmd ? 1 : 0);
  }

  // ── verify 子命令：**只读**核查「这条草稿到底在不在草稿箱里」────────
  //   为什么需要：素材是**永久素材**（进了素材库就占配额，清理要去 mp 后台人工删），
  //   而 draft/add 偶尔「回包成功但草稿没落库」。没有核查手段就只能重传一遍素材 →
  //   白占一份配额。有 verify 就能先查，查到就用 --material-ids 复用素材重建，不重传。
  //   ⚠️ 本分支只调 draft/get / draft/batchget，**不碰任何写入接口**。
  if (cmd === 'verify') {
    const mediaId = oneLine(args['media-id']);
    // 先立上下文：之后任何失败（缺凭证、token 取不到、接口报错）都打机器可读行 + 退出码 2，
    // 绝不混进「not_found / 退出码 1」——那会让编排层误以为「草稿不在」→ 白重传素材。
    _verifyCtx = { mediaId };
    if (!mediaId) fail('缺少 --media-id <草稿 media_id>（例：node platforms/wechat.cjs verify --media-id <id>）');

    await ipPreflight();
    _cred = loadCredential(args['app-id']);
    const token = await currentToken();

    const r = await findDraft(token, mediaId);
    if (r.error) fail(r.error);
    if (r.found) {
      console.log(`DRAFT_VERIFY: ok media_id=${mediaId} title=${r.title || '-'}`);
      finish(0);
      return;
    }
    console.log(`DRAFT_VERIFY: not_found media_id=${mediaId}`);
    finish(1);
    return;
  }

  // check/push 前自动比对出口 IP（fail-soft：探测失败不阻塞，token 步骤仍会兜底拦截）
  await ipPreflight();

  _cred = loadCredential(args['app-id']);
  console.log(`凭证来源：${_cred.source}（appId=${_cred.appId}）`);
  const token = await currentToken();

  // 用 finish(0) 而不是 process.exit(0)：立即退出会打断 keep-alive 句柄，
  // 在 Windows 上触发 libuv 断言把退出码污染成 0xC0000409（实测复现）。
  if (cmd === 'check') { ok('token 获取成功，API 通道可用。'); finish(0); return; }

  const title = args.title || '';
  if (!title) fail('缺少 --title（newspic 标题必填，≤32 字）');
  if ([...title].length > TITLE_MAX) fail(`标题 ${[...title].length} 字超过 newspic 上限 ${TITLE_MAX} 字：${title}`);

  let content = '';
  if (args['body-file']) {
    content = fs.readFileSync(args['body-file'], 'utf8').trim();
    if ([...content].length > BODY_MAX) fail(`正文 ${[...content].length} 字符超过 content 硬上限 ${BODY_MAX}。`);
    if ([...content].length > BODY_WARN) console.warn(`⚠ 正文 ${[...content].length} 字符超过建议值 ${BODY_WARN}，贴图配文宜短。`);
    // 物料守卫：推草稿是 API 通道的"准交付"动作，正文含 undefined/NaN 一律拒绝
    // ——曾有上游生成脚本的 bug 把「undefined。」推进已发布文章，返工需删稿重发
    if (/undefined|NaN|\[object Object\]/.test(content)) fail('[物料守卫] body-file 含 undefined/NaN，疑似上游生成 bug：先修文件再推送');
  }

  // ── ⚠️ 防重复闸门（2026-10-26 内化）：**上传任何素材之前** ──────────
  //   「绝不重复发布」是第一红线。编排层（lib/publish-all.cjs）会查台账，
  //   但**直接调本脚本 push 就能绕过它** → 重复跑一次 =
  //   再上传一遍永久素材（白占素材库配额）+ 草稿箱里多一条重复草稿。
  //   所以 push 自己也要查一遍。
  //   位置很关键：闸门拦下时**一个素材都不上传**（素材上传不可逆：进库了只能后台人工删）。
  //   台账没启用（config.yaml 没配 publish.ledger）→ assertNotRepeated 直接放行，零行为变化。
  //
  //   ⚠️ **变体（variant）要一起查**：台账的条目 id 是 `contentKey#variant#platform`，
  //   编排层写回时带的是什么变体取决于它那条线（图文线 'image' / 清单线 'default' / 旧格式无变体）。
  //   只查一种 → 记在别的变体下的那条就**漏了**（闸门形同虚设）。
  //   公众号只有图文一条线（PLATFORM_SCRIPTS.wechat 只有 image），
  //   所以「这条内容在公众号已经是 published/manual-handoff」不管记在哪个变体下都该拦。
  //   → 逐个查，任一命中就拦（台账没启用时全部放行，零行为变化）。
  const contentKey = oneLine(args['content-key']);
  if (contentKey) {
    const variants = [...new Set([args.variant, 'image', 'default', ''].filter((v) => v !== undefined && v !== null).map((v) => String(v).trim()))];
    let blocked = null;
    for (const variant of variants) {
      try {
        ledger.assertNotRepeated(cfg, {
          contentKey,
          platform: 'wechat',
          variant,
          allowRepeat: Boolean(args['allow-repeat']),
        });
      } catch (e) {
        blocked = e;
        break;
      }
    }
    if (blocked) fail(blocked.message); // 闸门拦下 → 退出码 1，此时**一个素材都没上传**
  }

  // ── 素材来源：新上传 vs 复用已上传 ─────────────────────────────────
  //   复用（--material-ids）：草稿没落库时，拿**已经上传过的**素材直接重建草稿，
  //   不重新上传 → 不再白占一份永久素材配额。
  const reuseIds = parseMaterialIds(args['material-ids']);
  const reuse = reuseIds.length > 0;
  if (args['material-ids'] && !reuse) fail('--material-ids 传了但没解析出任何 id（逗号分隔的 media_id 列表）');

  let files = [];
  let expectedCount = 0;
  if (args.media) {
    files = listImages(args.media, args.count ? parseInt(args.count, 10) : 0);
    expectedCount = files.length;
  } else if (args.count) {
    expectedCount = parseInt(args.count, 10) || 0;
  }

  if (reuse) {
    // ⚠️ 素材数必须与「本次要贴的图数」一致，不一致直接 FATAL ——
    //   绝不「能贴几张贴几张」：贴少了是一条残缺草稿（用户点发布才发现），贴多了平台报错。
    if (!expectedCount) expectedCount = reuseIds.length; // 没给 --media/--count → 无独立基准可比
    if (reuseIds.length !== expectedCount) {
      fail(
        `--material-ids 给了 ${reuseIds.length} 个素材，本次要贴 ${expectedCount} 张图，数量不一致 → 拒绝推送。\n` +
        `  （贴少了是残缺草稿，贴多了平台报错；宁可报错也不推一条错的。）\n` +
        `  对齐办法：--material-ids 的 id 个数 = 图集张数（--media 目录里的可用图，或 --count N）。`
      );
    }
    const dup = reuseIds.filter((id, i) => reuseIds.indexOf(id) !== i);
    if (dup.length) console.warn(`⚠ --material-ids 里有重复 id：${[...new Set(dup)].join(',')}（同一张图会被贴两次）`);
    console.log(`复用已上传素材 ${reuseIds.length} 张（不重新上传，不占新的素材库配额）：`);
    reuseIds.forEach((id, i) => console.log(`  ${i + 1}. …${id.slice(-6)}`));
  } else {
    if (!args.media) fail('缺少 --media <图片目录>（或用 --material-ids 复用已上传的素材）');
    console.log(`待上传 ${files.length} 张（首张即封面）：`);
    files.forEach((f) => console.log('  ' + path.basename(f)));
  }

  // ⚠️ 2026-10-22 内化：起浏览器/发 API **之前**的体检。
  //   推草稿是「准交付」动作 —— 推错了要去后台删草稿重推，代价比浏览器填单高得多。
  //   体检项：正文长度区间、正文里的 undefined/NaN、标题长度。
  //   ⚠️ **不传 mediaDir/declaredCount**：公众号的图集规则与通用规则**语义不同** ——
  //     通用规则按 `img-NN.png` 的序号归一；公众号是「cover 类最先、编号其次、end 类最后」
  //     （见上面的 listImages），把 `cover-3x4.png` 交给序号解析会被当成「序号 3」。
  //     公众号的张数与上限检查**已经由 listImages 自己做**（缺图 fail、超 20 张 fail），
  //     这里不重复实现（同一段判定逻辑只保留一个实现）。
  require('../lib/preflight.cjs').preflight({
    platform: 'wechat',
    bodyText: content,
    title,
    limits: { titleMax: TITLE_MAX, bodyMax: BODY_MAX, bodyMin: 1 },
  });
  const { create } = require('../lib/log.cjs');
  const log = create({ platform: 'wechat', kind: 'image' });
  log.step('素材清单', `${reuse ? reuseIds.length : files.length} 张${reuse ? '（复用已上传）' : ''}`);
  log.step('标题', `${[...title].length} 字`);

  const mediaIds = [];
  if (reuse) {
    // 复用路径：**不调任何上传接口**，直接把已有 media_id 带进 draft/add
    mediaIds.push(...reuseIds);
    log.step('永久素材', `${mediaIds.length} 张（复用，未新增上传）`);
  } else {
    for (const f of files) {
      const mediaId = await uploadImage(token, f);
      mediaIds.push(mediaId);
      console.log(`  已传永久素材：${path.basename(f)} → …${mediaId.slice(-6)}`);
    }
    log.step('永久素材上传', `${mediaIds.length} 张`);
  }

  // ⚠️ **先打 MATERIAL_IDS 再推草稿**：
  //   draft/add 失败时素材**已经进库了**（永久素材，清理要去 mp 后台人工删）。
  //   编排层靠这一行拿到 media_id → 用 `push --material-ids` 复用同一批素材重建草稿，
  //   不重新上传 → 不白占第二份素材库配额。这行必须早于 draft/add 打印。
  console.log(`MATERIAL_IDS: ${mediaIds.join(',')}`);

  const draft = await pushDraft(token, { title, content, mediaIds });
  if (!draft.media_id) {
    if (draft.errcode === 48001) fail('48001：账号无 draft/add 权限（接口权限被回收？）。到后台「设置与开发-接口权限」核对。');
    fail(`推草稿失败：${JSON.stringify(draft)}`);
  }
  console.log(`DRAFT_MEDIA_ID: ${draft.media_id}`);
  ok(`贴图草稿已入草稿箱（newspic，${mediaIds.length} 图），media_id 尾号 …${draft.media_id.slice(-6)}`);
  log.step('草稿已入箱', `media_id 尾号 …${draft.media_id.slice(-6)}`);
  log.finish('ok');
  console.log('\n下一步（契约，人工）：');
  console.log('  1. mp.weixin.qq.com「内容管理-草稿」核对贴图样式，点「发布」；');
  console.log('  2. 发布成功后回填你自己的发布记录（状态 + 文章链接）；');
  console.log('  3. 本次新踩的坑记进你自己的项目笔记（本包不代管平台踩坑记录）。');
  // 用 finish(0) 而不是 process.exit(0)：立即退出会截断管道里未冲完的 stdout
  // （Windows 上管道写是异步的）→ MATERIAL_IDS / DRAFT_MEDIA_ID 这两行会被截半。
  finish(0);
}

main().catch((e) => fail(e.stack || e.message));
