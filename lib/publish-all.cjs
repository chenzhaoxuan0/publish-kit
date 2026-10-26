// lib/publish-all.cjs — 并行编排器
//
// 为什么需要：publish-kit 原本每个平台脚本都是**独立 CLI 进程**（自己连 CDP、自己跑、自己退），
// 想要「一次发 9 个平台」只能手工开 9 个终端。本模块提供一条命令的编排。
//
// 实测（2026-10-21 期素材，8 图 + 视频）：
//   串行 9 平台：613.1s
//   并行 9 平台：120.7s 墙钟（**5.1×**）
//
// ── 三条从实测里长出来的规则（别删）─────────────────────────────────
//
// ① **长任务优先调度**：按各平台实测耗时**从大到小**先发。
//    否则并发有上限时，墙钟 ≈ 「最慢的排最后」那个，而不是最慢平台本身的耗时。
//
// ② **默认并发上限 5**：9 全并发会触发**平台侧限流**——同账号并发上传时，
//    知乎的图集一直只上到 7 张（补传还会把重复图当成第 8 张 → 图集区只有 7 张）。
//    实测降到 5 反而更快（145.6s → 120.7s）且 9/9 成功。要一把梭用 concurrency=99。
//
// ③ **每平台一个独立空间/进程**：并行时**不能**共用同一个浏览器上下文，
//    否则表单内容互相串（实测抖音图文与其他平台并发时图集只剩 1 张）。
//
// ── 2026-10-26 增补：清单驱动 + 失败诊断 + 自动重试 ─────────────────
//
// ① **槽位（slot）是执行单位**，不是「平台」。一个槽位 = 「某个平台的某个形态 +
//    它自己的物料 + 它要跑的命令序列」。清单见 lib/manifest.cjs。
// ② **抖音是多命令平台**（open→upload→fill→…→shot，每步一个进程，靠浏览器里
//    那个标签页续上下文）。早期版本这里对抖音只生成了一条**不带子命令**的命令，
//    而 douyin.cjs 的默认子命令是 `open` → **只开了页、没填单，却报成功**。
//    现在命令序列统一由 manifest.planCommands() 生成，编排层只管按序执行。
// ③ **失败后自动诊断**（lib/diagnose.cjs）：区分「通道整体不可用」「登录态失效」
//    「物料被拒」「仅截图失败」「偶发失败」——只有后两类允许重试。
// ④ **自动重试只重跑失败的那一步**，且该步必须**幂等**；API 通道（公众号）
//    永不自动重跑 —— 公众号是永久素材，重跑 = 白占素材库配额。
//
// 用法：
//   node bin/publish-all.cjs --video a.mp4 --title "标题" --body-file desc.txt \
//        --platforms douyin,weibo,zhihu --concurrency 5
//   node bin/publish-manifest.cjs publish.yaml            # 清单驱动

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cfg = require('./config.cjs');
const ledger = require('./ledger.cjs');
const manifest = require('./manifest.cjs');
const diagnoser = require('./diagnose.cjs');
const registry = require('./platforms.cjs');
const driver = require('./driver.cjs');

/**
 * 各平台的**实测**耗时（秒）—— 用来做长任务优先调度。
 * 数据来源：2026-10-21/22 期真实素材实测（见 README「实测耗时」节），
 * 现在统一收在 lib/platforms.cjs 的平台注册表里。
 * 新平台没有数据时给个保守值即可，调度照样能跑。
 */
const MEASURED = Object.fromEntries(
  Object.entries(registry.PLATFORMS).flatMap(([k, p]) =>
    Object.entries(p.measured || {}).map(([kind, s]) => [`${k}-${kind}`, s])
  )
);

/** 平台 → 该平台的形态脚本（清单模式下由 manifest 统一维护，这里只做转发） */
function scriptFor(platform, kind) {
  return registry.scriptOf(platform, kind);
}

/**
 * 旧接口：平台 → 单条命令。
 *
 * ⚠️ 保留是为了向后兼容（外部脚本与 selftest 都用它）。
 *    现在**真正执行**的是 buildCommands() 出来的命令序列。
 *    返回值里的 `args` 是「负责填单的那条命令」的参数（抖音是 `fill`），
 *    `commands` 字段给出完整序列。
 */
function buildCommand(platform, opts = {}) {
  const commands = buildCommands(platform, opts);
  if (!commands.length) return null;
  const main =
    commands.find((c) => c.label && c.label.startsWith('填')) ||
    commands.find((c) => c.label === '推草稿箱') ||
    commands[commands.length - 1];
  return { cmd: process.execPath, args: [...(main.script ? [path.join(cfg.ROOT, 'platforms', main.script)] : []), ...main.args], commands };
}

/**
 * 平台 → 命令序列（**唯一的实现**）。
 *
 * ⚠️ 不要在这里另写一份平台参数映射 —— 清单模式与旧模式必须共用同一份，
 *    否则两份实现必然漂移（这正是本仓库栽过的跟头）。
 */
function buildCommands(platform, opts = {}) {
  if (!scriptFor(platform, opts.kind || 'image')) return [];
  const slot = {
    platform,
    kind: opts.kind || 'image',
    title: opts.title || '',
    bodyFile: opts.bodyFile || '',
    media: opts.media || '',
    count: opts.count,
    video: opts.video || '',
    cover: opts.cover || '',
    tags: opts.tags || '',
    options: opts.options || {},
  };
  return manifest.planCommands(slot);
}

/* ──────────────────────────────────────────────────────────────
   单步执行
   ────────────────────────────────────────────────────────────── */

function spawnOne(script, args, onOut) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(cfg.ROOT, 'platforms', script), ...args], {
      cwd: cfg.ROOT,
      env: { ...process.env },
    });
    let out = '';
    const grab = (d) => {
      const s = d.toString();
      out += s;
      if (onOut) onOut(s);
    };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
  });
}

/**
 * ego 通道的单步执行：经 bin/ego-run.ps1（ego-browser 运行时）跑同一个平台脚本。
 *
 * · 扁平 argv → ScriptArgs 对象（ego 运行时不透传 argv，参数经 wrapper 的
 *   globalThis.__OP_ARGS__ 注入 —— 平台脚本两侧等价读取）。
 * · spawn('pwsh', [...]) 的传参形状与 operation/06_tools/publish-all.mjs 完全一致
 *   （生产验证过：-File + JSON 字符串在本机 pwsh 里不会拆坏）。
 */
function spawnEgo(script, flatArgs, onOut) {
  return new Promise((resolve) => {
    const scriptArgs = flatArgsToScriptArgs(flatArgs);
    const child = spawn(
      'pwsh',
      [
        '-NoProfile',
        '-File',
        path.join(cfg.ROOT, 'bin', 'ego-run.ps1'),
        '-Script',
        path.join(cfg.ROOT, 'platforms', script),
        '-ScriptArgs',
        JSON.stringify(scriptArgs),
      ],
      // ⚠️ stdin 必须 ignore（真机实测 2026-10-27）：默认 pipe 时 ego-browser CLI
      //    启动即挂死（CPU 0，等一个永远不会来数据的 stdin）；ignore = 立即 EOF。
      //    与 operation/06_tools/publish-all.mjs 的 stdio 形状一致（生产验证过）。
      { cwd: cfg.ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    const grab = (d) => {
      const s = d.toString();
      out += s;
      if (onOut) onOut(s);
    };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
  });
}

/** 扁平 argv（['open','--kind','image']）→ ScriptArgs 对象（{_:['open'], kind:'image'}）。
 *  与平台脚本里的 parseArgs 同一套语义：无值的开关读作 true。 */
function flatArgsToScriptArgs(flatArgs) {
  const out = { _: [] };
  const a = (flatArgs || []).map(String);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const key = a[i].slice(2);
      const next = a[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a[i]);
  }
  return out;
}

/** TaskSpace 空间名允许的字符集（对齐 operation 的 spaceName 正则 [A-Za-z0-9_-]） */
function sanitizeSpaceKey(s) {
  const out = String(s || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一个槽位的命令序列。
 *
 * @param {Object} slot 展开后的槽位（含 commands）
 * @param {Object} opts
 * @param {Function} [opts.onEvent]
 * @param {boolean} [opts.retry] 是否允许自动重试（默认 true）
 * @param {string} [opts.contentKey] 内容标识（ego 通道派生 TaskSpace 空间名用）
 * @returns {Object} {ok, ms, stdout, code, failedStep, diagnosis, attempts, spaceId}
 */
async function runSlot(slot, opts = {}) {
  const t0 = Date.now();
  const emit = opts.onEvent || (() => {});
  const commands = slot.commands || [];
  let stdout = '';
  let attempts = 0;
  let spaceId = '';

  // ── 通道判定：driver=ego 只影响**浏览器槽位**；API 槽位（公众号）永远直接 node ──
  const egoBrowser = driver.configuredChannel() === 'ego' && slot.via !== 'api';
  // TaskSpace 空间名 = `pk-<平台>-<线>-<spaceKey>`。spaceKey 取清单/内容标识派生，
  // 同一槽位的多条命令共享（douyin 的 open→upload→fill 序列靠它续上下文）；
  // 都没有时用 runSlot 起始时间戳兜底（单次运行内稳定，跨次不撞名）。
  const spaceKey =
    sanitizeSpaceKey(slot.spaceKey || opts.contentKey || slot.title || '') || `run-${t0}`;

  // ego 浏览器槽位的参数注入：
  //   · 每条命令 --space-key <key>（平台脚本用它定位/创建自己的 TaskSpace）
  //   · 最后一条命令加 --handoff 1 —— 只有它交还用户（handOff 之后 agent 接管不了，
  //     中间命令交还 = 后续命令全部撞墙；发布点击发生在整条序列完成之后）
  const spawnArgsOf = (c, i) => {
    if (!egoBrowser) return c.args;
    const a = [...c.args, '--space-key', spaceKey];
    if (i === commands.length - 1) a.push('--handoff', '1');
    return a;
  };
  const spawnCmd = (c, i, onOut) =>
    egoBrowser
      ? spawnEgo(c.script, spawnArgsOf(c, i), onOut)
      : spawnOne(c.script, c.args, onOut);

  const grabFor = () => (s) => {
    stdout += s;
    emit({ type: 'out', platform: slot.platform, text: s });
  };
  // 从 stdout 抓 spaceId（ego 门面会打 `spaceId=N` / `spaceId : N` 两种形状，
  // 与 operation/06_tools/publish-all.mjs 的抓法对齐）—— 台账/接管要用
  const noteSpaceId = () => {
    const m = stdout.match(/spaceId\s*[:=]\s*(\d+)/);
    if (m) spaceId = m[1];
  };

  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    attempts++;
    emit({ type: 'step', platform: slot.platform, label: c.label });
    const r = await spawnCmd(c, i, grabFor());
    noteSpaceId();
    if (r.code === 0) continue;

    // ── 失败：先诊断，再决定要不要重试 ──────────────────────────────
    const d = diagnoser.diagnose({
      code: r.code,
      stdout: r.out,
      platform: slot.platform,
      step: c.label,
    });
    const retryable =
      opts.retry !== false &&
      d.canRetry &&
      c.idempotent !== false && // 非幂等的步骤（重新上传素材）不重试
      slot.via !== 'api'; // API 通道（公众号永久素材）永不自动重跑

    if (retryable) {
      emit({ type: 'retry', platform: slot.platform, label: c.label });
      console.warn(
        `\n⚠ [${slot.platform}] 「${c.label}」失败（${d.label}）→ 8~12s 后重试一次\n`
      );
      await sleep(8000 + Math.random() * 4000);
      const r2 = await spawnCmd(c, i, grabFor());
      noteSpaceId();
      attempts++;
      if (r2.code === 0) continue;
      const d2 = diagnoser.diagnose({
        code: r2.code,
        stdout: r2.out,
        platform: slot.platform,
        step: c.label,
      });
      return {
        ok: false,
        ms: Date.now() - t0,
        stdout,
        code: r2.code,
        failedStep: c.label,
        diagnosis: d2,
        attempts,
        spaceId,
      };
    }

    return {
      ok: false,
      ms: Date.now() - t0,
      stdout,
      code: r.code,
      failedStep: c.label,
      diagnosis: d,
      attempts,
      spaceId,
    };
  }

  return { ok: true, ms: Date.now() - t0, stdout, code: 0, failedStep: '', diagnosis: null, attempts, spaceId };
}

/* ──────────────────────────────────────────────────────────────
   槽位编排
   ────────────────────────────────────────────────────────────── */

/**
 * 跑一批槽位（清单模式的主入口）。
 *
 * @param {Object[]} slots 展开后的槽位（含 commands）
 * @param {Object} o
 * @param {number} [o.concurrency] 并发上限（默认 5）
 * @param {string} [o.contentKey] 防重复闸门用的内容标识
 * @param {boolean} [o.allowRepeat]
 * @param {Function} [o.onEvent]
 * @returns {Promise<Object>} {results, order, concurrency}
 */
async function publishSlots(slots, o = {}) {
  const concurrency = Math.max(1, o.concurrency ?? 5);
  const emit = o.onEvent || (() => {});
  const results = [];

  if (!slots.length) {
    throw new Error('没有可执行的槽位 —— 检查清单里的 slots，或用 --only 指定平台。');
  }

  // ① ⚠️ **没有命令序列的槽位 = 失败，不是「什么都没干但成功」**
  //   旧接口对「平台不支持该形态」（比如给 B站跑图文线）会拼不出任何命令。
  //   如果放任它跑完，那个槽位会以「0 步、退出码 0」收场 → **假成功**。
  //   这类槽位必须显式判失败并说清楚为什么。
  const preFailed = [];
  const runnableSlots = [];
  for (const s of slots) {
    if (s.commands && s.commands.length) {
      runnableSlots.push(s);
      continue;
    }
    const d = diagnoser.diagnose({
      code: 1,
      stdout: `平台 ${s.platform} 没有 ${s.kind} 形态的脚本`,
      platform: s.platform,
    });
    preFailed.push({
      platform: s.platform,
      label: s.label,
      variant: s.variant,
      kind: s.kind,
      ok: false,
      ms: 0,
      code: 1,
      stdout: '',
      failedStep: '（无对应脚本）',
      diagnosis: d,
      attempts: 0,
    });
  }
  results.push(...preFailed);
  slots = runnableSlots;
  if (!slots.length) {
    throw new Error(
      '所有槽位都没有可执行的命令 —— 检查清单里的平台与形态是否匹配。\n' +
        '  （B站与视频号只有视频线；公众号只有图文线。）'
    );
  }

  // ② ⚠️ **防重复闸门：起浏览器之前统一拦**
  //   「绝不重复发布」是第一红线，但页面态判据只挡得住「同一个标签页还没关」。
  //   台账挡的是**跨进程、跨期**的重复：昨天发过、已交割给你还没点、失败重跑。
  //   台账**可选**：config.yaml 没配 publish.ledger 就完全不影响现有用法。
  if (o.contentKey && !o.allowRepeat) {
    for (const s of slots) {
      if (s.via === 'manual') continue; // 人工通道不填单，不查闸门
      try {
        ledger.assertNotRepeated(cfg, {
          contentKey: o.contentKey,
          platform: s.platform,
          variant: s.variant,
          allowRepeat: false,
        });
      } catch (e) {
        console.error(`\n✗ [防重复闸门] ${s.platform}: ${e.message}\n`);
        emit({ type: 'blocked', platform: s.platform, reason: e.message });
        throw e;
      }
    }
  }

  // ② 调度：长任务优先；**独占槽位单独一组，不与别人并发**
  const weight = (s) =>
    s.weight || MEASURED[`${s.platform}-${s.kind}`] || MEASURED[`${s.platform}-video`] || 60;
  const exclusive = slots.filter((s) => s.exclusive).sort((a, b) => weight(b) - weight(a));
  const normal = slots.filter((s) => !s.exclusive).sort((a, b) => weight(b) - weight(a));
  const order = [...exclusive.map((s) => s.platform), ...normal.map((s) => s.platform)];
  emit({ type: 'plan', order, concurrency, exclusive: exclusive.map((s) => s.platform) });

  const runOne = async (s) => {
    emit({ type: 'start', platform: s.platform, label: s.label });
    const r = await runSlot(s, { onEvent: emit, retry: o.retry, contentKey: o.contentKey });
    const rec = {
      platform: s.platform,
      label: s.label,
      variant: s.variant,
      kind: s.kind,
      ok: r.ok,
      ms: r.ms,
      code: r.code,
      stdout: r.stdout,
      failedStep: r.failedStep,
      diagnosis: r.diagnosis,
      attempts: r.attempts,
      spaceId: r.spaceId || '',
    };
    // 台账写回（**可选**：没配 publish.ledger 就不写，行为零变化）
    // 状态语义：跑通 = manual-handoff（已填完交割给你，等你点发布）
    //           失败 = failed（下次可重试）
    if (o.contentKey && s.via !== 'manual') {
      try {
        ledger.setEntry(cfg, {
          contentKey: o.contentKey,
          platform: s.platform,
          variant: s.variant,
          status: r.ok ? ledger.STATUS.MANUAL_HANDOFF : ledger.STATUS.FAILED,
          note: r.ok
            ? '并行填单完成，已停在发布按钮前' + (r.spaceId ? ` · spaceId ${r.spaceId}` : '')
            : `退出码 ${r.code}${r.failedStep ? ` · 失败步骤：${r.failedStep}` : ''}${
                r.diagnosis ? ` · ${r.diagnosis.label}` : ''
              }${r.spaceId ? ` · spaceId ${r.spaceId}` : ''}`,
        });
      } catch (e) {
        console.warn(`⚠ 台账写回失败（${s.platform}）：${e.message}`);
      }
    }
    emit({ type: 'done', platform: s.platform, ok: r.ok, ms: r.ms });
    return rec;
  };

  // 独占组：**串行**，且不与普通组并发
  for (const s of exclusive) results.push(await runOne(s));

  // 普通组：并行
  let idx = 0;
  async function worker() {
    while (idx < normal.length) {
      const s = normal[idx++];
      results.push(await runOne(s));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, normal.length) }, () => worker())
  );

  results.sort((a, b) => a.platform.localeCompare(b.platform));
  return { results, order, concurrency };
}

/* ──────────────────────────────────────────────────────────────
   旧接口（保持向后兼容）
   ────────────────────────────────────────────────────────────── */

/**
 * 并行跑多个平台（旧接口：一套物料打所有平台）。
 *
 * ⚠️ 保留是为了不破坏现有用法。**新代码请用 publishSlots()**（清单模式）——
 *    旧接口没法表达「每个平台各自的物料」。
 *
 * @param {Object} o
 * @param {string[]} o.platforms 平台 key 列表
 * @param {string} [o.kind] image / video
 * @param {number} [o.concurrency] 并发上限（默认 5）
 * @param {Object} [o.material] 物料参数（video/media/title/bodyFile/cover/tags/count）
 * @param {Function} [o.onEvent] (evt) => void 进度回调
 * @returns {Promise<Array>} 每个平台的结果 {platform, ok, ms, code, stdout}
 */
async function publishAll(o = {}) {
  const platforms = (o.platforms || []).filter((p) => cfg.enabled(p));
  if (!platforms.length) {
    throw new Error(
      '没有可执行的平台。请在 config.yaml 里把要用的平台 enabled: true，或用 --platforms 指定。'
    );
  }
  const kind = o.kind === 'video' ? 'video' : 'image';
  const slots = platforms.map((p) => {
    const commands = buildCommands(p, { ...(o.material || {}), kind });
    return {
      platform: p,
      label: manifest.PLATFORM_LABELS[p] || p,
      kind,
      variant: kind, // 旧接口里「线」就当变体用
      via: p === 'wechat' ? 'api' : 'browser',
      commands,
    };
  });
  const r = await publishSlots(slots, o);
  // 旧接口的返回形状：results 里没有 variant 字段的问题 → 保留 platform/ok/ms/code/stdout
  return r;
}

/** 把结果渲染成一张表 */
function formatResults(result) {
  const rows = result.results.map((r) => ({
    平台: r.label || r.platform,
    结果: r.ok ? '✓' : '✗',
    耗时: `${(r.ms / 1000).toFixed(1)}s`,
    退出码: r.code,
  }));
  const total = result.results.reduce((s, r) => s + r.ms, 0);
  const wall = Math.max(...result.results.map((r) => r.ms), 0);
  const diag = result.results
    .filter((r) => !r.ok && r.diagnosis)
    .map(
      (r) =>
        `\n  ✗ ${r.label || r.platform}（失败步骤：${r.failedStep || '—'}）\n` +
        diagnoser
          .formatDiagnosis(r.diagnosis)
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n')
    )
    .join('');
  return (
    `\n===== 并行填单汇总（并发上限 ${result.concurrency}）=====\n` +
    rows.map((r) => `  ${r.平台.padEnd(12)} ${r.结果}  ${r.耗时.padStart(8)}  (exit ${r.退出码})`).join('\n') +
    `\n  串行合计 ${(total / 1000).toFixed(1)}s` +
    `  ·  实际墙钟 ≈ ${(wall / 1000).toFixed(1)}s（并发 ${result.concurrency}）\n` +
    diag +
    `\n  ⚠ 各平台都停在「发布」按钮前，**发布由你本人点击**。\n`
  );
}

module.exports = {
  publishAll,
  publishSlots,
  runSlot,
  formatResults,
  MEASURED,
  buildCommand,
  buildCommands,
  spawnEgo,
  flatArgsToScriptArgs,
  sanitizeSpaceKey,
};
