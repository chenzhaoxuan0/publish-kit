// lib/platforms.cjs — 平台登录态事实源（当前由 bin/doctor.cjs 与 bin/login.cjs 消费）
//
// 各平台脚本原本各写一行登录判定（B站判 passport 域名、微博判 signin、
// 知乎判「发想法」按钮在不在、视频号判 URL 含 login），散在 8 个脚本里。
// 这里收拢成一张表，供 doctor 体检与 login 登录页共用。
//
// 注意：8 个平台脚本目前还没有 require 这个模块，各自保留着自己的登录预检。
// 若要收敛，让脚本改读本表时务必逐个核对——两边判据不完全一致（见各平台脚本里的登录检查），
// 不要以为统一了就是等价的。
const PLATFORM_LOGIN = {
  douyin: {
    label: '抖音',
    url: 'https://creator.douyin.com/creator-micro/content/upload',
    async detect(page) {
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
    async detect(page) {
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
    async detect(page) {
      if (/signin|login/i.test(page.url())) return false;
      // 「发想法」按钮未登录时不渲染——与 zhihu-pin.cjs 沿用同一判据
      return page.evaluate(() => document.body.innerText.includes('分享此刻的想法')).catch(() => false);
    },
  },

  weibo: {
    label: '微博',
    url: 'https://weibo.com/upload/channel',
    async detect(page) {
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
    async detect(page) {
      // wujie 微前端，壳首页恒存在不能作为判据，只认 login 跳转
      if (/login/i.test(page.url())) return false;
      return page.evaluate(() => document.body.innerText.includes('发表视频')).catch(() => false);
    },
  },

  wechat: {
    label: '公众号',
    api: true, // 走官方 API，不经浏览器，无需登录态
    hasCredentials(cfg) {
      return !!(cfg.hint('wechat', 'app_id') && cfg.hint('wechat', 'app_secret'));
    },
  },
};

function keys() {
  return Object.keys(PLATFORM_LOGIN);
}

function get(k) {
  return PLATFORM_LOGIN[k];
}

/** 把用户输入的中文/别名解析成平台 key */
function resolve(input) {
  if (!input) return '';
  const s = String(input).trim().toLowerCase();
  if (PLATFORM_LOGIN[s]) return s;
  const alias = {
    抖音: 'douyin', douyin: 'douyin',
    b站: 'bilibili', bili: 'bilibili', 哔哩哔哩: 'bilibili', bilibili: 'bilibili',
    知乎: 'zhihu', zhihu: 'zhihu',
    微博: 'weibo', weibo: 'weibo',
    视频号: 'shipinhao', sph: 'shipinhao', shipinhao: 'shipinhao',
    公众号: 'wechat', weixin: 'wechat', wechat: 'wechat',
  };
  return alias[s] || '';
}

module.exports = { PLATFORM_LOGIN, keys, get, resolve };
