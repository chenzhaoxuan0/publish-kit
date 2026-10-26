// lib/platform-urls.cjs — 平台 ↔ 发布链接 的对照表 / 守卫 / 匿名核验
//
// ## 为什么要有这个文件
//
// 多平台发完要把「每条内容的发布链接」回填进台账。这件事的危险不在「填错一条」，
// 而在于**填错之后它会自己活下来**：
//   台账链接 → 被预填进回填页面的输入框 → 用户每次点「保存」都把它写回台账。
// → 一条贴错格子的链接（比如把**视频号**的链接放进「小红书·视频」那一格）
//   会从「一次手滑」变成「长期驻留」，一直活到有人逐条核对为止。
//
// ## 三条硬规则（`urlMatchesPlatform` 的语义）
//
//   ① 链接属于**别的**平台 → false（拒写）。跨平台错位是能明确判定的。
//   ② 链接**不属于任何**已知平台 → false（宁可空着让上层报出来，也不要瞎写）。
//   ③ 平台**本身不在对照表里** → true（不拦，别因为不认识新平台就挡住人家填单）。
//
// ## ⚠️ 公众号与视频号同域 —— 只能靠路径区分
//
//   mp.weixin.qq.com/s/…    = 公众号
//   weixin.qq.com/sph/…     = 视频号
// 两个平台都在 weixin.qq.com 域下 → 这张表的 pathPrefixes / pathRequired 就是干这个的。
//
// ## ⚠️ 小红书禁核验
//
// 小红书域名连「匿名 GET 探活」都不允许（风控敏感）。所以 `verifyUrl` 对它
// **一个 HTTP 请求都不发**，直接返回 skipped —— 红线在本层，不靠调用方自觉。

// ── 平台 ↔ 链接对照表 ──────────────────────────────────────────────────────
//
// 字段：
//   platform       平台 key（与 lib/platforms.cjs 的 key 对齐）
//   label          中文名（提示信息里用）
//   hosts          域名（含其子域：`douyin.com` 覆盖 www. / v.）
//   pathPrefixes   已知路径形态（前缀）
//   pathPatterns   已知路径形态（正则）
//   pathRequired   true = 路径必须命中上面任一形态才算这个平台的链接（默认 false：
//                  多数平台的主机名已经唯一，路径只用来分辨「图文 / 视频」等形态）
//   rotatingPaths  轮换 token 路径（同一内容每次复制得到的 URL 都不同）
//   stablePaths    稳定 ID 路径（同一内容永远是同一个 URL）
//
// ⚠️ pathPrefixes / pathPatterns 是**实测确定的形态**，改之前先想清楚：
//    它们既是「这链接属于哪个平台」的判据，也是「这链接是图文还是视频」的判据。
const PLATFORM_URL_RULES = [
  {
    platform: 'douyin',
    label: '抖音',
    hosts: ['douyin.com'],
    pathPrefixes: ['/note/', '/video/'], // 图文 = note，视频 = video
    stablePaths: [{ prefix: '/note/' }, { prefix: '/video/' }],
  },
  {
    platform: 'zhihu',
    label: '知乎',
    hosts: ['zhihu.com'],
    pathPrefixes: ['/pin/', '/p/'], // 想法 = pin，文章 = p
    stablePaths: [{ prefix: '/pin/' }, { prefix: '/p/' }],
  },
  {
    platform: 'weibo',
    label: '微博',
    hosts: ['weibo.com'],
    pathPatterns: [/^\/\d+\/[A-Za-z0-9]+$/], // /<uid>/<mid>
    stablePaths: [{ pattern: /^\/\d+\/[A-Za-z0-9]+$/ }],
  },
  {
    platform: 'bilibili',
    label: 'B站',
    hosts: ['bilibili.com'],
    pathPrefixes: ['/video/'],
    pathPatterns: [/^\/video\/BV[0-9A-Za-z]+$/],
    stablePaths: [{ prefix: '/video/' }],
  },
  {
    platform: 'wechat',
    label: '公众号',
    hosts: ['mp.weixin.qq.com'],
    pathPrefixes: ['/s/'],
    pathRequired: true, // 公众号只能认 mp.weixin.qq.com/s/…
    stablePaths: [{ prefix: '/s/' }],
  },
  {
    platform: 'shipinhao',
    label: '视频号',
    hosts: ['weixin.qq.com'],
    pathPrefixes: ['/sph/'],
    pathRequired: true, // 视频号只能认 weixin.qq.com/sph/…
    rotatingPaths: [{ prefix: '/sph/' }],
  },
  {
    platform: 'xiaohongshu',
    label: '小红书',
    hosts: ['xiaohongshu.com', 'xhslink.com'],
  },
];

/** 平台 key / 中文名 / 常见别名 → 平台 key（与 lib/platforms.cjs 的 alias 对齐 + 小红书） */
const PLATFORM_ALIASES = {
  douyin: 'douyin',
  抖音: 'douyin',
  zhihu: 'zhihu',
  知乎: 'zhihu',
  weibo: 'weibo',
  微博: 'weibo',
  bilibili: 'bilibili',
  bili: 'bilibili',
  b站: 'bilibili',
  哔哩哔哩: 'bilibili',
  shipinhao: 'shipinhao',
  视频号: 'shipinhao',
  sph: 'shipinhao',
  wechat: 'wechat',
  公众号: 'wechat',
  mp: 'wechat',
  xiaohongshu: 'xiaohongshu',
  小红书: 'xiaohongshu',
  xhs: 'xiaohongshu',
  rednote: 'xiaohongshu',
};

/** 把用户/调用方给的名字解析成平台 key（认不出就原样返回，交给上层决定） */
function resolvePlatformKey(platform) {
  const s = String(platform || '').trim();
  if (!s) return '';
  return PLATFORM_ALIASES[s.toLowerCase()] || PLATFORM_ALIASES[s] || s;
}

/** 平台 key → 规则（不在表里返回 null） */
function ruleOf(platform) {
  const key = resolvePlatformKey(platform);
  if (!key) return null;
  return PLATFORM_URL_RULES.find((r) => r.platform === key) || null;
}

/** 平台 key → 中文名 */
function labelOf(platform) {
  const r = ruleOf(platform);
  return r ? r.label : String(platform || '');
}

// ── URL 解析小工具 ──────────────────────────────────────────────────────────

/** 解析 URL；不是合法 URL 返回 null（不抛错 —— 这层只做判定，不该炸） */
function parseUrl(url) {
  try {
    return new URL(String(url || '').trim());
  } catch (_) {
    return null;
  }
}

/** 主机名等于该域名，或它是它的子域 */
function hostIs(u, base) {
  const p = u instanceof URL ? u : parseUrl(u);
  if (!p) return false;
  const h = String(p.hostname || '').toLowerCase();
  const b = String(base || '').toLowerCase();
  if (!h || !b) return false;
  return h === b || h.endsWith('.' + b);
}

/** 路径是否命中规则声明的形态（前缀 + 正则，任一命中即可） */
function pathMatches(rule, p) {
  const prefixes = rule.pathPrefixes || [];
  const patterns = rule.pathPatterns || [];
  if (!prefixes.length && !patterns.length) return true; // 没声明形态 → 不约束
  const pth = p.pathname || '/';
  for (const pre of prefixes) {
    const clean = String(pre);
    if (!clean) continue;
    if (pth.startsWith(clean)) return true;
    if (pth === clean.replace(/\/+$/, '')) return true; // '/s' 也算 '/s/…'
  }
  for (const re of patterns) {
    try {
      if (re.test(pth)) return true;
    } catch (_) {
      /* 非法正则当没这条 */
    }
  }
  return false;
}

/** 这条链接是不是这个平台的 */
function ruleMatches(rule, url) {
  const p = parseUrl(url);
  if (!p) return false;
  const hostOk = (rule.hosts || []).some((h) => hostIs(p, h));
  if (!hostOk) return false;
  if (rule.pathRequired && !pathMatches(rule, p)) return false;
  return true;
}

/**
 * 这条链接属于哪个已知平台（认不出返回 ''）。
 *
 * @param {string} url
 * @returns {string} 平台 key 或 ''
 */
function platformOfUrl(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  for (const rule of PLATFORM_URL_RULES) {
    if (ruleMatches(rule, u)) return rule.platform;
  }
  return '';
}

/**
 * 这条链接能不能写进这个平台的格子（**硬闸**）。
 *
 * @param {string} url      链接
 * @param {string} platform 平台 key（'weibo'）或中文名（'微博'）
 * @returns {boolean}
 */
function urlMatchesPlatform(url, platform) {
  const u = String(url || '').trim();
  const rule = ruleOf(platform);
  if (!rule) return true; // 平台不在表里 → 不拦（别误伤自定义平台）
  if (!u) return true; // 空链接由调用方自己处理
  return ruleMatches(rule, u);
}

/**
 * `urlMatchesPlatform` 的**带理由**版本（给人看的拒绝原因）。
 *
 * @returns {{ok:boolean, reason:string, detected:string}} detected = 实际识别出的平台
 */
function explainUrlMatch(url, platform) {
  const u = String(url || '').trim();
  const rule = ruleOf(platform);
  if (!rule) return { ok: true, reason: '', detected: '' };
  if (!u) return { ok: true, reason: '空链接', detected: '' };
  if (ruleMatches(rule, u)) return { ok: true, reason: '', detected: rule.platform };
  const detected = platformOfUrl(u);
  const p = parseUrl(u);
  const host = p ? p.hostname : u.slice(0, 60);
  if (detected && detected !== rule.platform) {
    return {
      ok: false,
      detected,
      reason: `这条链接属于「${labelOf(detected)}」，不属于「${rule.label}」（跨平台错位）`,
    };
  }
  return {
    ok: false,
    detected,
    reason: `链接域名「${host}」与平台「${rule.label}」不符`,
  };
}

// ── URL 抽取 ────────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s"'<>（）【】《》，。；！？、]+/g;
/** 尾随标点：中文句读 + 英文括号引号 —— 复制分享文案时最容易粘进来 */
const TRAILING_PUNCT = /[)\]}>,.;:!?'"`、。，；：！？）】》」』"'，。！？]+$/;

/**
 * 从一段文字里抽出所有 http(s) 链接（去重、去掉尾随标点）。
 *
 * App 的「复制链接」给的是整段分享文案（口令、@人名、表情混在一起），
 * URL 就泡在里面 —— 所以这里不要求整段文本就是链接。
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractUrls(text) {
  const s = String(text || '');
  const found = s.match(URL_RE) || [];
  const out = [];
  for (let u of found) {
    u = u.replace(TRAILING_PUNCT, '');
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

// ── 核验 ────────────────────────────────────────────────────────────────────

/**
 * 禁核验平台名单。**小红书默认在内**：它连匿名探活都不允许。
 * ⚠️ 这是个**活对象**：`setNoVerify()` 会就地改写它，外部 import 到的引用始终是当前值。
 */
const NO_VERIFY_PLATFORMS = ['xiaohongshu'];

/**
 * 覆盖禁核验名单（调用方说了算）。
 * @param {string[]} list 平台 key / 中文名数组（传空数组 = 全部解禁）
 * @returns {string[]} 当前名单的副本
 */
function setNoVerify(list) {
  const arr = Array.isArray(list) ? list : [];
  NO_VERIFY_PLATFORMS.length = 0;
  for (const item of arr) {
    const k = resolvePlatformKey(item);
    if (k && !NO_VERIFY_PLATFORMS.includes(k)) NO_VERIFY_PLATFORMS.push(k);
  }
  return NO_VERIFY_PLATFORMS.slice();
}

/** 这条链接 / 这个平台是不是禁核验的（禁 → 一个请求都不发） */
function isNoVerify(platform, url) {
  if (!NO_VERIFY_PLATFORMS.length) return false;
  const key = resolvePlatformKey(platform || '');
  if (key && NO_VERIFY_PLATFORMS.includes(key)) return true;
  const detected = platformOfUrl(url);
  if (detected && NO_VERIFY_PLATFORMS.includes(detected)) return true;
  // 域名兜底：链接域名本身就是禁核验平台的 → 一样一个请求都不发
  return NO_VERIFY_PLATFORMS.some((k) =>
    (ruleOf(k) || { hosts: [] }).hosts.some((h) => hostIs(url, h))
  );
}

/** 匿名 UA：表明是个普通客户端，不伪造浏览器指纹 */
const ANON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

/**
 * 匿名 GET 核验一次（**不带 Cookie / 鉴权头**）。
 *
 * 口径：
 *   2xx/3xx        → { ok:true,  status, reason:'已核验 HTTP xxx' }
 *   403            → { ok:false, status:403, reason:'反爬（403）' } ← **常态，不是脚本坏了**
 *   超时 / 网络错  → { ok:false, status:0,   reason:'核验超时（…）' / '网络错误：…' }
 *   禁核验平台     → { ok:null,  skipped:true, reason:'该平台禁止核验（未发出任何请求）' }
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {string} [opts.platform]  平台 key / 中文名（不传就靠域名反查）
 * @param {number} [opts.timeoutMs] 超时（默认 10000）
 * @param {Function} [opts.fetch]   注入的 fetch 实现（默认 globalThis.fetch，方便打桩自检）
 * @returns {Promise<{ok:boolean|null, status:number, skipped:boolean, reason:string, ms:number}>}
 */
async function verifyUrl(url, opts = {}) {
  const u = String(url || '').trim();
  const t0 = Date.now();
  if (!u) return { ok: false, status: 0, skipped: false, reason: '空链接', ms: 0 };

  // ⛔ 禁核验判定必须在**发请求之前** —— 命中就直接返回，一个字节都不发出去
  const platform = resolvePlatformKey(opts.platform || '') || platformOfUrl(u);
  if (isNoVerify(platform, u)) {
    return { ok: null, status: 0, skipped: true, reason: '该平台禁止核验（未发出任何请求）', ms: 0 };
  }

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;
  const doFetch = opts.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return {
      ok: false,
      status: 0,
      skipped: false,
      reason: '当前运行时没有 fetch（需要 Node 18+）',
      ms: Date.now() - t0,
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(u, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': ANON_UA,
        Accept: 'text/html,application/xhtml+xml',
        // ⚠️ 刻意**不带** Cookie / Authorization / Referer —— 匿名核验，带了就等于拿登录态探活
      },
    });
    const status = Number(res && res.status) || 0;
    const ms = Date.now() - t0;
    if (status >= 200 && status < 400) {
      return { ok: true, status, skipped: false, reason: `已核验 HTTP ${status}`, ms };
    }
    if (status === 403) {
      return { ok: false, status, skipped: false, reason: '反爬（403）', ms };
    }
    return { ok: false, status, skipped: false, reason: `HTTP ${status}`, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = (e && e.message) || String(e);
    const aborted = (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) || /abort/i.test(msg);
    return {
      ok: false,
      status: 0,
      skipped: false,
      reason: aborted ? `核验超时（${timeoutMs}ms）` : `网络错误：${msg}`,
      ms,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── 轮换 token 型链接 ───────────────────────────────────────────────────────
//
// **轮换 token 型链接** = 同一条内容，每次「复制链接」拿到的 URL 都不同，但指向同一条。
//
// 为什么要在意：
//   台账里已经有这条内容的链接时，再采一次会拿到**新 token**。无脑替换的话，
//   台账链接会「每次回填都变一次」—— 人工核对时对不上，也无法判断是否重复发布。
//   → 这类链接：**台账已有链接就不自动替换**（人工粘贴照常覆盖）。
//
// 判定分两层（先表后形）：
//   ① **表判**（权威）：规则里显式声明了 rotatingPaths / stablePaths 的，按声明走。
//      实测视频号 weixin.qq.com/sph/<token> 就是这种：同一条内容连续复制三次拿到
//      A4ZiDVExL / AlXOAnvbj / AM0WoMurK，三个都能正常打开（HTTP 200，内容一致）。
//   ② **形判**（兜底）：表里没有的平台，看末段是不是「随机 token 段」——
//      长度 8~32、**大小写混写**（平台的稳定 ID 多为纯数字或固定前缀，如 B 站的 BV…）、
//      路径里没有「≥6 位纯数字 ID 段」这种稳定锚点、且路径不止一段
//      （只有一段的多是短链域名，其短码本身是稳定的）。

const TOKEN_RE = /^[A-Za-z0-9_-]{8,32}$/;

/** 末段是不是「随机 token 段」 */
function looksRandomToken(pathname) {
  const segs = String(pathname || '')
    .split('/')
    .filter(Boolean);
  if (segs.length < 2) return false; // 只有一段 → 多是短链域名的稳定短码
  const last = segs[segs.length - 1];
  if (!TOKEN_RE.test(last)) return false;
  if (!/[A-Z]/.test(last) || !/[a-z]/.test(last)) return false; // 随机 base62 段 = 大小写混写
  if (segs.some((s) => /^\d{6,}$/.test(s))) return false; // 有稳定 ID 锚点 → 不是轮换 token
  return true;
}

/** 路径条目（{host?, prefix?, pattern?}）是否命中 */
function pathEntryMatches(entry, p) {
  if (!entry) return false;
  if (entry.host && !hostIs(p, entry.host)) return false;
  const pth = p.pathname || '/';
  if (entry.prefix) {
    const clean = String(entry.prefix);
    if (!(pth.startsWith(clean) || pth === clean.replace(/\/+$/, ''))) return false;
  }
  if (entry.pattern) {
    try {
      if (!entry.pattern.test(pth)) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

/** 规则里声明的路径条目集合里有没有命中的 */
function anyPathEntry(entries, p) {
  if (!Array.isArray(entries)) return false;
  return entries.some((e) => pathEntryMatches(e, p));
}

/**
 * 这条链接是不是「轮换 token 型链接」。
 *
 * @param {string} url
 * @returns {boolean}
 */
function isRotatingTokenUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  const p = parseUrl(u);
  if (!p) return false;
  const rule = ruleOf(platformOfUrl(u));
  if (rule) {
    if (anyPathEntry(rule.rotatingPaths, p)) return true; // ① 表判：显式声明的轮换路径
    if (anyPathEntry(rule.stablePaths, p)) return false; // ① 表判：显式声明的稳定路径
  }
  return looksRandomToken(p.pathname || '/'); // ② 形判：兜底
}

module.exports = {
  PLATFORM_URL_RULES,
  PLATFORM_ALIASES,
  NO_VERIFY_PLATFORMS,
  platformOfUrl,
  urlMatchesPlatform,
  explainUrlMatch,
  extractUrls,
  verifyUrl,
  setNoVerify,
  isRotatingTokenUrl,
  resolvePlatformKey,
  labelOf,
};
