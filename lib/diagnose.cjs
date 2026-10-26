// lib/diagnose.cjs — 填单失败后的**自动诊断**
//
// ## 为什么需要
//
// 一次填单失败，脚本只给你一个退出码和一个 stack。想知道「接下来该干什么」，
// 过去只能人肉翻日志、逐个试：
//
//   · 是**浏览器通道**整体挂了（CDP 连不上、导航失败）？→ 再跑几次也是白跑，
//     应该去修通道 / 起浏览器。
//   · 是**登录态**掉了？→ 该让用户扫码，不是让脚本重试。
//   · 是**素材或文案**被平台拒了？→ 重试一万次也是同一个错。
//   · 只是**截图**没截到？→ 填单其实已经成功，截图是旁路，判据全在 DOM。
//     这种失败过去会把整轮发布判死 —— 实测：三个平台的图都传完了，
//     只因一次 `Page.captureScreenshot` 超时，整轮白跑。
//
// 这个模块把这些判据固化成**一行结论 + 一条可执行建议**。
//
// ## 分级（这就是全部的判断力所在）
//
//   channel-dead    通道整体不可用（nav/eval/CDP 级别坏）→ **别再填单**，先修通道
//   login-required  登录态失效 → 让用户扫码，**别自动重试**
//   content-rejected 素材/文案被平台拒 → 重试无意义，改物料
//   retryable       可重试（超时、偶发点击失败）→ 重跑一次
//   cosmetic        只是截图失败 → **填单其实是成功的**，不用重跑
//   unknown         认不出来 → 给人看，不自动重试
//
// ## 边界（重要）
//
// 诊断**只读**：它读平台脚本的输出文本，不碰浏览器、不重试、不改任何东西。
// 「要不要重试」的决定权在编排层（lib/publish-all.cjs），
// 而且**只有 retryable / cosmetic 才允许重试** —— 重试永久素材（公众号）
// 是配额事故，不是性能优化。

/** 结论枚举 */
const VERDICT = {
  CHANNEL_DEAD: 'channel-dead',
  LOGIN_REQUIRED: 'login-required',
  CONTENT_REJECTED: 'content-rejected',
  RETRYABLE: 'retryable',
  COSMETIC: 'cosmetic',
  UNKNOWN: 'unknown',
};

/**
 * 判据表。
 *
 * ⚠️ 顺序有意义：先判「通道级」，再判「登录」，再判「内容」，最后才轮到
 *    「可重试」。因为通道级坏掉时，输出里往往**同时**出现登录相关的字样
 *    （页面被重定向到登录页），先判通道才不会误导。
 */
const RULES = [
  {
    verdict: VERDICT.CHANNEL_DEAD,
    // 通道级坏：导航失败、连接断了、执行上下文没了 —— 这些都不是重跑能解决的
    patterns: [
      /connectOverCDP/i,
      /ECONNREFUSED/i,
      /Target (?:closed|page|context) closed/i,
      /Session closed/i,
      /Browser (?:closed|has been closed)/i,
      /net::ERR_[A-Z_]+/i,
      /Execution context was destroyed/i,
      /page\.(?:goto|evaluate|locator)/i,
      /Cannot find context/i,
      /WebSocket.*(?:closed|error)/i,
      /浏览器.*(?:连接|断开)/,
      /导航失败/,
      // ── ego 通道 ──
      /taskSpace is not defined/, // 脚本没经 bin/ego-run.ps1 跑（wrapper 没注入）
      /\[space\] 空间/, // 空间及备选都打不开（ego 通道级故障）
      /Failed to connect to ego_cli/i, // ego CLI 版本错配 / 沙箱限制（exit 5）
      /未找到 ego-browser/, // ego lite 没装或不在已知位置
      /runtime\.driver: ego/, // 声明了 ego 却在普通 node 里跑
      /ego 通道不支持/,
    ],
    advice:
      '通道整体不可用（导航/执行上下文/CDP 级别的问题）—— **不要再填单**。\n' +
      '  ① 先跑 node bin/doctor.cjs 看 CDP 是否在线（它会自动拉起 Chrome）；\n' +
      '  ② ego 通道：到 ego lite 窗口确认 TaskSpace 状态；pwsh -File bin/ego-run.ps1 -WhatIfOnly 可干跑运行器；\n' +
      '  ③ Chrome 起着但仍失败 → 关掉那个标签页重开，页面可能已经僵死；\n' +
      '  ④ 仍失败 → 平台可能改版了，检查该平台脚本文件头的坑位注释。',
  },
  {
    verdict: VERDICT.LOGIN_REQUIRED,
    patterns: [
      /未登录/i,
      /请登录/i,
      /需要登录/i,
      /扫码/i,
      /passport\./i,
      /signin/i,
      /newlogin/i,
      /login\.html/i,
      /invalid ip/i, // 公众号 IP 白名单 —— 归到「要人工处理」这一类
      /access_token.*(?:invalid|expired)/i,
      /errmsg.*(?:invalid|expired)/i,
      // ── ego 通道 ──
      /hard stop/i, // 接管被拒 = 空间已交还给用户（等用户，不是失败）
      /接管.*(?:被拒|拒绝)/,
    ],
    advice:
      '登录态失效（或公众号凭证 / IP 白名单有问题）—— **重试没用**。\n' +
      '  ① 浏览器平台：node bin/login.cjs <平台> 打开登录页，让用户自己扫码；\n' +
      '  ② 公众号：node platforms/wechat.cjs check 查凭证与 IP 白名单。',
  },
  {
    verdict: VERDICT.CONTENT_REJECTED,
    patterns: [
      /缺 --/,
      /文件不存在/,
      /缺图|图片缺失/,
      /图集不足/,
      /体检未通过/,
      /preflight/i,
      /标题.*(?:超|超过).*上限/,
      /正文.*(?:超|超过).*上限/,
      /未找到.*(?:话题|合集|标签|选项|声明)/,
      /未配置/,
      /违禁/,
    ],
    advice:
      '物料或文案被挡住（缺文件 / 体检不过 / 平台找不到某个必填项）—— **重试没用**。\n' +
      '  ① 先看上面的具体报错（缺什么补什么）；\n' +
      '  ② 平台找不到必填项时，多半是平台改版 → 读该平台脚本文件头的坑位注释。',
  },
  {
    verdict: VERDICT.COSMETIC,
    patterns: [
      /截图(?:失败|超时|异常)/,
      /Page\.captureScreenshot/i,
      /screenshot.*(?:timeout|timed out|failed)/i,
    ],
    advice:
      '只是**截图**没截到 —— 判据全在 DOM，填单结果不受影响。\n' +
      '  可以直接重跑（截图失败不该让整轮发布作废）。',
  },
  {
    verdict: VERDICT.RETRYABLE,
    patterns: [
      /Timeout .* exceeded/i,
      /超时/,
      /没唤起文件选择器/i,
      /点上传入口/,
      /ECONNRESET/i,
      /EAI_AGAIN/i,
    ],
    advice:
      '偶发失败（超时 / 点击没生效）—— **可以重跑一次**。\n' +
      '  连续两次都失败就不是偶发 → 当成通道问题排查。',
  },
];

/**
 * 诊断一次失败。
 *
 * @param {Object} o
 * @param {number} [o.code] 退出码
 * @param {string} [o.stdout] 平台脚本标准输出
 * @param {string} [o.stderr] 平台脚本错误输出
 * @param {string} [o.platform] 平台 key（用于给出更贴切的建议）
 * @param {string} [o.step] 失败发生在哪一步（清单模式下是子命令标签）
 * @returns {Object} { verdict, label, advice, matched, canRetry }
 */
function diagnose(o = {}) {
  const text = [o.stdout, o.stderr].filter(Boolean).join('\n');
  const code = o.code;

  // 退出码 0 但我们被叫来诊断 —— 没有失败可诊断
  if (code === 0 && !text.trim()) {
    return result(VERDICT.UNKNOWN, [], '没有失败信息可诊断');
  }

  for (const rule of RULES) {
    const matched = rule.patterns.filter((p) => p.test(text));
    if (matched.length) {
      const r = result(rule.verdict, matched, rule.advice);
      r.step = o.step || '';
      r.platform = o.platform || '';
      r.code = code;
      return r;
    }
  }

  const r = result(
    VERDICT.UNKNOWN,
    [],
    '认不出失败类型 —— **不自动重试**。请看该平台日志（publish.log_dir 下）里最后几行。'
  );
  r.step = o.step || '';
  r.platform = o.platform || '';
  r.code = code;
  // 退出码 1 且输出里**有明确的报错标记** → 多半是脚本自己抛的错（业务性），
  // 比「信号被杀」更可能是内容/物料问题。
  // ⚠️ 必须是「有报错标记」才这么判 —— 光凭退出码 1 就归因成内容问题，
  //    会把「看不懂的失败」误导成「改文案就行」，那是更坏的误导。
  if (code === 1 && /\bError\b|错误|失败|throw|异常/i.test(text)) {
    r.verdict = VERDICT.CONTENT_REJECTED;
    r.label = '内容/物料被拒';
    r.advice =
      '脚本自己抛的错（退出码 1），多半是物料或文案问题 —— **重试没用**。\n' +
      '  看报错首行即可定位（缺什么补什么）。';
  }
  return r;
}

function result(verdict, matched, advice) {
  const LABELS = {
    [VERDICT.CHANNEL_DEAD]: '通道不可用',
    [VERDICT.LOGIN_REQUIRED]: '登录态失效',
    [VERDICT.CONTENT_REJECTED]: '内容/物料被拒',
    [VERDICT.RETRYABLE]: '可重试',
    [VERDICT.COSMETIC]: '仅截图失败',
    [VERDICT.UNKNOWN]: '认不出',
  };
  return {
    verdict,
    label: LABELS[verdict] || verdict,
    advice,
    matched: matched.map(String),
    // 只有「偶发失败」与「仅截图失败」允许自动重试。
    // ⚠️ 截图失败重跑其实是**不必要**的（填单已经成了），但重跑代价低、
    //    且能补上截图 → 允许。内容/登录/通道类一律不重试。
    canRetry: verdict === VERDICT.RETRYABLE || verdict === VERDICT.COSMETIC,
  };
}

/** 渲染成一行人类可读的结论 */
function formatDiagnosis(d, extra = '') {
  return (
    `诊断：${d.label}（${d.verdict}）${extra ? ' · ' + extra : ''}\n` +
    (d.matched.length ? `  命中判据：${d.matched.slice(0, 3).join(' / ')}\n` : '') +
    d.advice
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')
  );
}

module.exports = { VERDICT, diagnose, formatDiagnosis };
