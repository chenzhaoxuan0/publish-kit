// lib/driver.cjs — 运行通道工厂（playwright | ego）
//
// ── 两条通道 ────────────────────────────────────────────────────────────
//   playwright（默认）：惰性 require patchright → connectOverCDP 连外部 CDP Chrome。
//                      行为与 driver 抽象引入之前**完全一致**。
//   ego：脚本本身跑在 `ego-browser nodejs` 运行时里（bin/ego-run.ps1 启动），
//        由 lib/drivers/ego.cjs 的门面提供 Playwright 形状的 page/ctx。
//
// ── 通道判定 ────────────────────────────────────────────────────────────
//   环境事实优先：globalThis.__OP_ARGS__ 只可能由 bin/ego-run.ps1 的 wrapper 注入 ——
//   看到它 = 当前在 ego 运行时里 = ego 通道。
//   config.runtime.driver 是**意图声明**：声明了 ego 却在普通 node 里跑 → 明确报错
//   （而不是静默回落 playwright，那会让「想走 ego」的调用悄悄走错通道）。
//
// ⚠️ patchright 只在 playwright 分支惰性加载 —— ego 运行时里绝不 import 它
//    （ego 官方约束："Do not import Playwright or launch another browser"）。

const cfg = require('./config.cjs');

/** config 里的通道意图：'playwright'（默认）| 'ego' */
function configuredChannel() {
  const raw = String((cfg.load().runtime && cfg.load().runtime.driver) || 'playwright').trim().toLowerCase();
  if (['ego', 'ego-lite', 'egolite'].includes(raw)) return 'ego';
  if (raw === 'playwright' || raw === '') return 'playwright';
  throw new Error(
    `[driver] config.yaml runtime.driver 取值不认识：${raw}（可选 playwright | ego）`
  );
}

/** 当前进程实际所在的通道：__OP_ARGS__ 存在 = ego 运行时 */
function runtimeChannel() {
  return globalThis.__OP_ARGS__ && typeof globalThis.__OP_ARGS__ === 'object' ? 'ego' : 'playwright';
}

/** TaskSpace 空间名前缀。publish-kit 用 pk —— 与 operation 的 op 隔离
 *  （TaskSpace 空间名是 ego 应用**全局唯一**的，前缀撞车会互相接管对方的表单页） */
function spacePrefix() {
  const v = String((cfg.load().runtime && cfg.load().runtime.space_prefix) || 'pk').trim();
  return v || 'pk';
}

/**
 * 打开会话，返回通道相关的句柄。
 *
 * playwright → { driver:'playwright', ctx, browser }   （ctx 为真实 patchright context）
 * ego        → { driver:'ego', ctx, task, spaceId, spaceName, handOff() }（ctx 为门面）
 *
 * @param {Object} o
 * @param {string} o.platform 平台 key（ego 空间名组成部分）
 * @param {string} [o.spaceKey] 内容标识（ego 空间名组成部分；一期一个空间）
 * @param {number|string} [o.spaceId] 台账记录的空间 id（ego 接管路径，必须显式传）
 */
async function openSession(o = {}) {
  const env = runtimeChannel();
  const want = configuredChannel();

  if (env === 'ego') {
    const ego = require('./drivers/ego.cjs');
    const session = await ego.createEgoSession({
      platform: o.platform,
      kind: o.kind,
      spaceKey: o.spaceKey,
      spaceId: o.spaceId,
      prefix: spacePrefix(),
    });
    if (want !== 'ego') {
      // 环境是 ego 就走 ego —— 但要把配置意图的不一致说出来，避免「以为在走 playwright」
      console.warn(
        `⚠ [driver] config.yaml 的 runtime.driver 是 ${want}，但当前进程在 ego 运行时里 —— 按 ego 通道执行。`
      );
    }
    return session;
  }

  if (want === 'ego') {
    throw new Error(
      '[driver] config.yaml 设了 runtime.driver: ego，但当前是普通 node 进程。\n' +
        '  ego 通道必须经 bin/ego-run.ps1 运行：\n' +
        '    pwsh -NoProfile -File bin/ego-run.ps1 -Script platforms/<脚本> -ScriptArgs @{ ... }\n' +
        '  或把 runtime.driver 改回 playwright。'
    );
  }

  // playwright 通道：与既有行为完全一致
  let chromium;
  try {
    chromium = require('patchright').chromium;
  } catch {
    throw new Error('patchright 未安装。在 publish-kit 目录下跑：npm install');
  }
  const browser = await chromium.connectOverCDP(process.env.CDP_URL || cfg.cdpUrl(), { timeout: 15000 });
  const ctx = browser.contexts()[0];
  return { driver: 'playwright', ctx, browser };
}

module.exports = { configuredChannel, runtimeChannel, spacePrefix, openSession };
