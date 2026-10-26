#!/usr/bin/env node
// bin/publish-manifest.cjs — 清单驱动的发布入口
//
// 一条命令，按**清单**填多个平台。清单说什么就发什么 —— 每个平台可以用**自己的**
// 标题、正文、封面、标签，而不是「一份物料打所有平台」。
//
//   node bin/publish-manifest.cjs publish.yaml
//   node bin/publish-manifest.cjs publish.yaml --variants image
//   node bin/publish-manifest.cjs publish.yaml --only douyin,zhihu
//   node bin/publish-manifest.cjs publish.yaml --dry-run     # 只打印将要跑什么
//   node bin/publish-manifest.cjs publish.yaml --check-only  # 只体检，不填单
//
// 参数：
//   --variants    只要这几个变体（逗号分隔，如 image,video）
//   --only        只要这几个平台（逗号分隔）
//   --dry-run     只打印命令，不执行
//   --check-only  只做体检（清单校验 + 物料存在性），不执行任何命令
//   --concurrency 并发上限（默认 5 —— 见 lib/publish-all.cjs 的「为什么是 5」）
//   --content-key 内容标识（防重复闸门用；清单里写了 content.key 就用它）
//   --allow-repeat 显式允许重复发布（绕过台账闸门）
//   --no-retry    关闭失败自动重试
//
// ⚠️ 无论并行还是串行，**发布都由你本人点击**。脚本只填到发布按钮前。
//
// ⚠️ 清单里 `via: manual` 的槽位**不会执行任何自动化** —— 只在结果里标出来，
//    提醒你人工去发（零自动化是账号级决策，工具不该替你破例）。

const path = require('path');
const cfg = require('../lib/config.cjs');
const manifest = require('../lib/manifest.cjs');
const { publishSlots, formatResults } = require('../lib/publish-all.cjs');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];

  if (!file) {
    console.error(
      `\n用法：node bin/publish-manifest.cjs <清单.yaml> [选项]\n` +
        `  例：node bin/publish-manifest.cjs publish.yaml --variants image\n` +
        `  清单长什么样，见 docs/manifest.example.yaml\n`
    );
    process.exit(1);
  }
  if (!cfg.exists()) {
    console.error(
      `找不到 config.yaml（${cfg.CONFIG_PATH}）。\n  先跑一次初始化：  node bin/init.cjs\n`
    );
    process.exit(1);
  }

  const variants = args.variants && args.variants !== true ? String(args.variants).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const only = args.only && args.only !== true ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : null;

  let plan;
  try {
    plan = manifest.buildPlan(file, { variants, only });
  } catch (e) {
    console.error(`\n✗ ${e.message}\n`);
    process.exit(1);
  }

  // ── 体检结果先说清楚 ──────────────────────────────────────────
  console.log(`\n清单：${plan.file}`);
  console.log(`内容标识：${plan.content.key || '（未填 → 不启用防重复闸门）'}`);
  console.log(`变体：${Object.keys(plan.variants || {}).join(', ') || '（无）'}`);
  console.log(`槽位：${plan.slots.length} 个`);
  for (const s of plan.slots) {
    const via = s.via === 'manual' ? '人工（不自动化）' : s.via === 'api' ? 'API' : '浏览器';
    console.log(`  · ${s.label || s.platform} [${s.variant}/${s.kind}] ${via} —— ${s.commands.length} 步`);
  }

  if (plan.problems.warn.length) {
    console.log(`\n⚠ ${plan.problems.warn.length} 条提醒：`);
    for (const w of plan.problems.warn) console.log(`  ⚠ ${w}`);
  }
  if (plan.problems.fail.length) {
    console.error(`\n✗ 体检未通过（${plan.problems.fail.length} 条）—— 已中止，不起浏览器：`);
    for (const f of plan.problems.fail) console.error(`  ✗ ${f}`);
    console.error(
      `\n  体检不碰浏览器、秒级；不过就不执行 —— 宁可不发，也不发错。\n`
    );
    process.exit(1);
  }

  const manual = plan.slots.filter((s) => s.via === 'manual');
  const runnable = plan.slots.filter((s) => s.via !== 'manual');

  if (manual.length) {
    console.log(
      `\n⚠ ${manual.length} 个槽位是「人工」通道 —— **不会执行任何自动化**：\n` +
        manual.map((s) => `  · ${s.label || s.platform}：${s.note || '（清单里没写要做什么）'}`).join('\n')
    );
  }
  if (!runnable.length) {
    console.log('\n没有可执行的槽位。\n');
    process.exit(0);
  }

  // ── dry-run：只打印 ──────────────────────────────────────────
  if (args['dry-run']) {
    console.log(`\n—— dry-run：将依次执行以下命令 ——`);
    for (const s of runnable) {
      console.log(`\n[${s.label || s.platform}] ${s.variant}/${s.kind}`);
      for (const c of s.commands) {
        console.log(`   $ node platforms/${c.script} ${c.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
      }
    }
    console.log('');
    process.exit(0);
  }

  // ── check-only：只体检 ───────────────────────────────────────
  if (args['check-only']) {
    console.log(`\n✓ 体检通过（${runnable.length} 个可执行槽位）—— check-only，未执行任何命令。\n`);
    process.exit(0);
  }

  console.log(
    `\n清单填单：${runnable.length} 个槽位 · 并发上限 ${args.concurrency ?? 5}\n` +
      `  ⚠ 只填单不发布，**发布由你本人点击**。\n`
  );

  const contentKey = args['content-key'] && args['content-key'] !== true ? String(args['content-key']) : plan.content.key;

  const result = await publishSlots(runnable, {
    concurrency: args.concurrency ? Number(args.concurrency) : 5,
    contentKey,
    allowRepeat: Boolean(args['allow-repeat']),
    retry: args['no-retry'] ? false : true,
    onEvent: (e) => {
      if (e.type === 'plan') {
        console.log(`  调度顺序（长任务优先）: ${e.order.join(' → ')}`);
        if (e.exclusive && e.exclusive.length) {
          console.log(`  独占槽位（不与别人并发）: ${e.exclusive.join(', ')}`);
        }
      } else if (e.type === 'start') {
        console.log(`  ▶ ${e.label || e.platform} 开始`);
      } else if (e.type === 'step') {
        console.log(`    · ${e.label}`);
      } else if (e.type === 'retry') {
        console.log(`  ↻ ${e.platform} 的「${e.label}」重试一次`);
      } else if (e.type === 'done') {
        console.log(`  ${e.ok ? '✓' : '✗'} ${e.platform} 结束（${(e.ms / 1000).toFixed(1)}s）`);
      }
    },
  });

  console.log(formatResults(result));
  const failed = result.results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`⚠ ${failed.length} 个平台失败：${failed.map((f) => f.platform).join(', ')}\n`);
  }
  if (manual.length) {
    console.log(`⚠ ${manual.length} 个槽位待人工发布：${manual.map((m) => m.label || m.platform).join(', ')}\n`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(1);
});
