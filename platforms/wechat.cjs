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
 *   node platforms/wechat.cjs push --media <图片目录> --title "<标题 ≤32 字>"
 *                    [--body-file <纯文本正文>] [--count N] [--app-id <appId>]
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
 * 返回：草稿 media_id。「发布」是人工动作，发布成功后自行回填你的发布记录。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config.cjs');

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

const fail = (msg) => { console.error('❌ ' + msg); process.exit(1); };
const ok = (msg) => console.log('✅ ' + msg);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
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

  if (!cmd || !['check', 'push'].includes(cmd)) {
    console.log('用法：\n  node platforms/wechat.cjs ip\n  node platforms/wechat.cjs check\n  node platforms/wechat.cjs push --media <图片目录> --title "<标题 ≤32 字>" [--body-file <纯文本>] [--count N] [--app-id <appId>]');
    process.exit(cmd ? 1 : 0);
  }

  // check/push 前自动比对出口 IP（fail-soft：探测失败不阻塞，token 步骤仍会兜底拦截）
  await ipPreflight();

  _cred = loadCredential(args['app-id']);
  console.log(`凭证来源：${_cred.source}（appId=${_cred.appId}）`);
  const token = await currentToken();

  if (cmd === 'check') { ok('token 获取成功，API 通道可用。'); process.exit(0); }

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

  const files = listImages(args.media, args.count ? parseInt(args.count, 10) : 0);
  console.log(`待上传 ${files.length} 张（首张即封面）：`);
  files.forEach((f) => console.log('  ' + path.basename(f)));

  const mediaIds = [];
  for (const f of files) {
    const mediaId = await uploadImage(token, f);
    mediaIds.push(mediaId);
    console.log(`  已传永久素材：${path.basename(f)} → …${mediaId.slice(-6)}`);
  }

  const draft = await pushDraft(token, { title, content, mediaIds });
  if (!draft.media_id) {
    if (draft.errcode === 48001) fail('48001：账号无 draft/add 权限（接口权限被回收？）。到后台「设置与开发-接口权限」核对。');
    fail(`推草稿失败：${JSON.stringify(draft)}`);
  }
  ok(`贴图草稿已入草稿箱（newspic，${mediaIds.length} 图），media_id 尾号 …${draft.media_id.slice(-6)}`);
  console.log('\n下一步（契约，人工）：');
  console.log('  1. mp.weixin.qq.com「内容管理-草稿」核对贴图样式，点「发布」；');
  console.log('  2. 发布成功后回填你自己的发布记录（状态 + 文章链接）；');
  console.log('  3. 本次新踩的坑记进你自己的项目笔记（本包不代管平台踩坑记录）。');
  process.exit(0);
}

main().catch((e) => fail(e.stack || e.message));
