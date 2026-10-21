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
// 用法：
//   node bin/publish-all.cjs --video a.mp4 --title "标题" --body-file desc.txt \
//        --platforms douyin,weibo,zhihu --concurrency 5

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cfg = require('./config.cjs');
const ledger = require('./ledger.cjs');

/**
 * 各平台的**实测**耗时（秒）—— 用来做长任务优先调度。
 * 数据来源：2026-10-21/22 期真实素材实测（见 README「实测耗时」节）。
 * 新平台没有数据时给个保守值即可，调度照样能跑。
 */
const MEASURED = {
  'douyin-video': 116,
  'douyin-image': 68,
  'bilibili-video': 69,
  'zhihu-video': 76,
  'zhihu-pin': 27,
  'weibo-video': 40,
  'weibo-image': 14,
  'shipinhao-video': 42,
  'wechat-image': 5, // 走 API，不占浏览器
};

/** 平台 → 脚本与参数拼装 */
function buildCommand(platform, opts) {
  const base = path.join(cfg.ROOT, 'platforms');
  const args = [];
  switch (platform) {
    case 'douyin':
      args.push(path.join(base, 'douyin.cjs'), '--kind', opts.kind || 'image');
      break;
    case 'weibo':
      args.push(
        opts.kind === 'video'
          ? path.join(base, 'weibo.cjs')
          : path.join(base, 'weibo-image.cjs')
      );
      break;
    case 'zhihu':
      args.push(
        opts.kind === 'video'
          ? path.join(base, 'zhihu.cjs')
          : path.join(base, 'zhihu-pin.cjs')
      );
      break;
    case 'bilibili':
      args.push(path.join(base, 'bilibili.cjs'));
      break;
    case 'shipinhao':
      args.push(path.join(base, 'shipinhao.cjs'));
      break;
    case 'wechat':
      args.push(path.join(base, 'wechat.cjs'), 'push');
      break;
    default:
      return null;
  }
  // 公共物料参数
  if (opts.video) args.push('--video', opts.video);
  if (opts.media) args.push('--media', opts.media);
  if (opts.count) args.push('--count', String(opts.count));
  if (opts.title) args.push('--title', opts.title);
  if (opts.bodyFile) args.push('--body-file', opts.bodyFile);
  if (opts.cover) args.push('--cover', opts.cover);
  if (opts.tags) args.push('--tags', opts.tags);
  return { cmd: process.execPath, args };
}

/**
 * 并行跑多个平台。
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
  const concurrency = Math.max(1, o.concurrency ?? 5);
  const emit = o.onEvent || (() => {});

  // ① 长任务优先调度（规则①）
  const weight = (p) => MEASURED[`${p}-${o.kind || 'image'}`] ?? MEASURED[`${p}-video`] ?? 60;
  const queue = platforms
    .map((p) => ({ p, w: weight(p) }))
    .sort((a, b) => b.w - a.w)
    .map((x) => x.p);

  emit({ type: 'plan', order: queue, concurrency });

  // ② ⚠️ **防重复闸门：起浏览器之前统一拦**（2026-10-22 内化）
  //   「绝不重复发布」是第一红线，但页面态判据只挡得住「同一个标签页还没关」。
  //   台账挡的是**跨进程、跨期**的重复：昨天发过、已交割给你还没点、失败重跑。
  //   台账**可选**：config.yaml 没配 publish.ledger 就完全不影响现有用法。
  if (o.contentKey && !o.allowRepeat) {
    for (const p of queue) {
      try {
        ledger.assertNotRepeated(cfg, { contentKey: o.contentKey, platform: p, allowRepeat: false });
      } catch (e) {
        console.error(`\n✗ [防重复闸门] ${p}: ${e.message}\n`);
        emit({ type: 'blocked', platform: p, reason: e.message });
        throw e;
      }
    }
  }

  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < queue.length) {
      const platform = queue[idx++];
      const built = buildCommand(platform, { ...o.material, kind: o.kind });
      if (!built) {
        results.push({ platform, ok: false, ms: 0, code: -1, stdout: `未知平台 ${platform}` });
        continue;
      }
      const t0 = Date.now();
      emit({ type: 'start', platform });
      const r = await new Promise((resolve) => {
        const child = spawn(built.cmd, built.args, {
          cwd: cfg.ROOT,
          env: { ...process.env },
        });
        let out = '';
        child.stdout.on('data', (d) => {
          out += d.toString();
          emit({ type: 'out', platform, text: d.toString() });
        });
        child.stderr.on('data', (d) => {
          out += d.toString();
          emit({ type: 'out', platform, text: d.toString() });
        });
        child.on('close', (code) => resolve({ code, out }));
        child.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
      });
      const ms = Date.now() - t0;
      const ok = r.code === 0;
      results.push({ platform, ok, ms, code: r.code, stdout: r.out });
      // ③ 台账写回（**可选**：没配 publish.ledger 就不写，行为零变化）
      //    状态语义：跑通 = manual-handoff（已填完交割给你，等你点发布）
      //              失败 = failed（下次可重试）
      //    ⚠️ 写回失败**不能**静默吞 —— 但也不能因此让整轮崩掉，所以只告警。
      if (o.contentKey) {
        try {
          ledger.setEntry(cfg, {
            contentKey: o.contentKey,
            platform,
            status: ok ? ledger.STATUS.MANUAL_HANDOFF : ledger.STATUS.FAILED,
            note: ok ? '并行填单完成，已停在发布按钮前' : `退出码 ${r.code}`,
          });
        } catch (e) {
          console.warn(`⚠ 台账写回失败（${platform}）：${e.message}`);
        }
      }
      emit({ type: 'done', platform, ok, ms });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  results.sort((a, b) => a.platform.localeCompare(b.platform));
  return { results, order: queue, concurrency };
}

/** 把结果渲染成一张表 */
function formatResults(result) {
  const rows = result.results.map((r) => ({
    平台: r.platform,
    结果: r.ok ? '✓' : '✗',
    耗时: `${(r.ms / 1000).toFixed(1)}s`,
    退出码: r.code,
  }));
  const total = result.results.reduce((s, r) => s + r.ms, 0);
  const wall = Math.max(...result.results.map((r) => r.ms), 0);
  return (
    `\n===== 并行填单汇总（并发上限 ${result.concurrency}）=====\n` +
    rows.map((r) => `  ${r.平台.padEnd(12)} ${r.结果}  ${r.耗时.padStart(8)}  (exit ${r.退出码})`).join('\n') +
    `\n  串行合计 ${(total / 1000).toFixed(1)}s` +
    `  ·  实际墙钟 ≈ ${(wall / 1000).toFixed(1)}s（并发 ${result.concurrency}）\n` +
    `  ⚠ 各平台都停在「发布」按钮前，**发布由你本人点击**。\n`
  );
}

module.exports = { publishAll, formatResults, MEASURED, buildCommand };
