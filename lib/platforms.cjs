// lib/platforms.cjs — **平台注册表**（唯一事实源）
//
// ## 为什么要有这张表
//
// 过去平台信息散在好几处：登录判据在 `lib/platforms.cjs`、脚本映射在
// `lib/manifest.cjs`、实测耗时在 `lib/publish-all.cjs`、标题上限在各平台脚本里。
// 漏改一处就静默失效 —— 「B站明明只有视频线，清单里写了图文线」这类问题
// 排查起来最费时间。现在**一张表**说清每个平台的：
//
//   label       中文名
//   url         创作页地址（登录探针用）
//   api         是否走官方 API（不经浏览器）
//   automation  auto | manual —— **manual = 零自动化**（账号级决策，工具只拦不破例）
//   kinds       支持哪些形态（image / video）
//   script      形态 → 平台脚本文件名
//   measured    实测填单耗时（秒），编排时**最慢的先发**
//   limits      平台硬限制（**有实测依据的才写这里**）
//   alias       中文名/别名 → 平台 key
//   detect      登录态探针（只在 bin/login.cjs 与 doctor 里用；**不是填单前的闸门**）
//
// ## ⚠️ 登录态判据为什么仍散在各平台脚本里
//
// 各平台的判据确实不同（知乎判「发想法」按钮、视频号判壳首页），而判据都紧跟在
// 导航之后，就地判定最可靠。**不要为了「统一」去动它** —— 统一判据的改动风险
// 大于收益。这张表里的 `detect()` 只用于「要不要提示用户扫码」的探针。

/** 平台注册表 */
const PLATFORMS = {
  douyin: {
    label: '抖音',
    url: 'https://creator.douyin.com/creator-micro/content/upload',
    api: false,
    automation: 'auto',
    kinds: ['image', 'video'],
    script: { image: 'douyin.cjs', video: 'douyin.cjs' },
    measured: { image: 68, video: 116 },
    limits: { image: { titleMax: 30 }, video: { titleMax: 30 } },
    alias: ['抖音', 'douyin', 'dy'],
    detect(page) {
      if (/login|passport/i.test(page.url())) return false;
      return page
        .evaluate(
          () => !!document.querySelector('input[type=file]') || document.body.innerText.length > 2000
        )
        .catch(() => false);
    },
  },

  bilibili: {
    label: 'B站',
    url: 'https://member.bilibili.com/platform/upload/video/frame',
    api: false,
    automation: 'auto',
    kinds: ['video'], // ⚠️ B站没有图文线
    script: { video: 'bilibili.cjs' },
    measured: { video: 69 },
    limits: { video: { titleMax: 80 } },
    alias: ['B站', 'b站', 'bilibili', 'bili', '哔哩哔哩'],
    detect(page) {
      if (/passport\.bilibili\.com/i.test(page.url())) return false;
      return page
        .evaluate(
          () =>
            document.body.innerText.includes('投稿') ||
            !!document.querySelector('input[type=file]')
        )
        .catch(() => false);
    },
  },

  zhihu: {
    label: '知乎',
    url: 'https://www.zhihu.com/creator',
    api: false,
    automation: 'auto',
    kinds: ['image', 'video'],
    script: { image: 'zhihu-pin.cjs', video: 'zhihu.cjs' },
    measured: { image: 27, video: 76 },
    limits: { image: {}, video: { titleMax: 100 } },
    alias: ['知乎', 'zhihu'],
    detect(page) {
      if (/signin|login/i.test(page.url())) return false;
      // 「发想法」按钮未登录时不渲染——与 zhihu-pin.cjs 沿用同一判据
      return page.evaluate(() => document.body.innerText.includes('分享此刻的想法')).catch(() => false);
    },
  },

  weibo: {
    label: '微博',
    url: 'https://weibo.com/upload/channel',
    api: false,
    automation: 'auto',
    kinds: ['image', 'video'],
    script: { image: 'weibo-image.cjs', video: 'weibo.cjs' },
    measured: { image: 14, video: 40 },
    limits: { image: {}, video: {} },
    alias: ['微博', 'weibo'],
    detect(page) {
      if (/passport\.weibo|signin|newlogin/i.test(page.url())) return false;
      return page
        .evaluate(
          () => !!document.querySelector('input[type=file]') || document.body.innerText.includes('发布')
        )
        .catch(() => false);
    },
  },

  shipinhao: {
    label: '视频号',
    url: 'https://channels.weixin.qq.com/platform/home',
    api: false,
    automation: 'auto',
    kinds: ['video'],
    script: { video: 'shipinhao.cjs' },
    measured: { video: 42 },
    // 视频号短标题 ≤16 字 —— 全链路**唯一会 throw** 的标题上限
    limits: { video: { titleMax: 16 } },
    alias: ['视频号', 'sph', 'shipinhao'],
    detect(page) {
      // wujie 微前端，壳首页恒存在不能作为判据，只认 login 跳转
      if (/login/i.test(page.url())) return false;
      return page.evaluate(() => document.body.innerText.includes('发表视频')).catch(() => false);
    },
  },

  wechat: {
    label: '公众号',
    url: 'https://mp.weixin.qq.com',
    api: true, // 走官方 API，不经浏览器，无需登录态
    automation: 'auto',
    kinds: ['image'],
    script: { image: 'wechat.cjs' },
    measured: { image: 5 },
    limits: { image: {} },
    alias: ['公众号', 'weixin', 'wechat'],
    hasCredentials(cfg) {
      return !!(cfg.hint('wechat', 'app_id') && cfg.hint('wechat', 'app_secret'));
    },
  },
};

/** 旧名保留：doctor / login 消费的是这张表 */
const PLATFORM_LOGIN = PLATFORMS;

function keys() {
  return Object.keys(PLATFORMS);
}

function get(k) {
  return PLATFORMS[k];
}

/** 把用户输入的中文/别名解析成平台 key */
function resolve(input) {
  if (!input) return '';
  const s = String(input).trim().toLowerCase();
  if (PLATFORMS[s]) return s;
  for (const [k, p] of Object.entries(PLATFORMS)) {
    if ((p.alias || []).some((a) => a.toLowerCase() === s)) return k;
  }
  return '';
}

/**
 * 自动化闸门：某些平台是**零自动化**（账号级决策，例如某账号被限流后决定不自动发）。
 * 工具**只拦不破例** —— 清单里写了也不执行，改用 `via: manual` 只备料。
 *
 * @throws {Error} 该平台不允许自动化
 */
function assertAutoAllowed(k) {
  const p = PLATFORMS[k];
  if (!p) return;
  if (p.automation === 'manual') {
    throw new Error(
      `平台 ${p.label || k} 被标记为**零自动化**（automation: manual）。\n` +
        `  这是账号级决策，工具不会替你破例。\n` +
        `  清单里请用 via: manual（只备料，不执行任何自动化）。`
    );
  }
}

/** 该平台支持哪些形态 */
function kindsOf(k) {
  return PLATFORMS[k]?.kinds || [];
}

/** 该平台该形态的脚本文件（没有这一形态 → null） */
function scriptOf(k, kind) {
  return PLATFORMS[k]?.script?.[kind] || null;
}

/** 该平台该形态的实测耗时（秒）；没有数据 → undefined */
function measuredOf(k, kind) {
  return PLATFORMS[k]?.measured?.[kind];
}

/** 该平台该形态的标题上限；没有实测依据的 → undefined（不要瞎填） */
function titleLimitOf(k, kind) {
  return PLATFORMS[k]?.limits?.[kind]?.titleMax;
}

module.exports = {
  PLATFORMS,
  PLATFORM_LOGIN, // 旧名，向后兼容
  keys,
  get,
  resolve,
  assertAutoAllowed,
  kindsOf,
  scriptOf,
  measuredOf,
  titleLimitOf,
};
