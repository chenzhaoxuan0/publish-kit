#!/usr/bin/env node
// bin/publish-all.cjs — 并行填单入口
//
// 一条命令跑多个平台，各自独立进程、各自独立标签页，全部停在「发布」按钮前。
//
//   node bin/publish-all.cjs --platforms douyin,weibo,zhihu --kind image \
//        --media ./cards --count 8 --title "标题" --body-file body.txt
//
//   node bin/publish-all.cjs --platforms douyin,weibo,zhihu,bilibili,shipinhao \
//        --kind video --video a.mp4 --title "标题" --body-file body.txt \
//        --cover cover-3x4.png --tags "AI,大模型"
//
// 参数：
//   --platforms    逗号分隔的平台 key（默认 = config.yaml 里所有 enabled 的）
//   --kind         image | video（默认 image）
//   --concurrency  并发上限（默认 5 —— 见下方「为什么是 5」）
//   --content-key  内容标识（如 "2026-10-21_AI热点速递卡片#video"）。
//                  配了 publish.ledger 时用于**防重复发布闸门**（同一条内容只发一次）
//   --allow-repeat 显式允许重复（绕过台账闸门）
//   --video/--media/--count/--title/--body-file/--cover/--tags
//                  物料参数，透传给各平台脚本
//
// ── 为什么并发上限是 5（不是 9）────────────────────────────────────
//   9 平台全并发会触发**平台侧限流**：同账号并发上传时，知乎的图集一直只上到 7 张
//   （补传还会把重复图当成第 8 张 → 图集区只有 7 张）。
//   实测降到 5 反而更快（145.6s → 120.7s 墙钟）且 9/9 成功 —— 限流导致的失败重试
//   比多开两个并发更贵。要一把梭用 --concurrency 99（自己承担限流风险）。
//
// ── 前提：所有平台共用同一个 Chrome（config.yaml 的 runtime.cdp_url）────
//   各平台脚本各自 connectOverCDP + ctx.newPage()，所以并行时是「一个浏览器多个标签页」。
//   这是 publish-kit 既有的模型，这里没有改。
//
// ⚠️ 无论并行还是串行，**发布都由你本人点击**。脚本只填到发布按钮前。

const path = require('path');
const fs = require('fs');
const cfg = require('../lib/config.cjs');
const { publishAll, formatResults } = require('../lib/publish-all.cjs');

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
      out[key] = true; // 无值 flag
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!cfg.exists()) {
    console.error(
      `找不到 config.yaml（${cfg.CONFIG_PATH}）。\n` +
        `  先跑一次初始化：  node bin/init.cjs`
    );
    process.exit(1);
  }

  const platforms = args.platforms
    ? String(args.platforms).split(',').map((s) => s.trim()).filter(Boolean)
    : cfg.enabledList();

  const kind = args.kind === 'video' ? 'video' : 'image';

  // 公众号走 API，不占浏览器，但它没有 --media 之外的多数参数，单独处理
  const material = {
    video: args.video,
    media: args.media,
    count: args.count ? Number(args.count) : undefined,
    title: args.title,
    bodyFile: args['body-file'],
    cover: args.cover,
    tags: args.tags,
  };

  // ⚠️ **前置校验：物料不全就不许启动任何平台脚本**（2026-10-22 加）
  //   为什么重要：编排器会**并发**起 N 个进程，各自 connectOverCDP 连**用户的浏览器**。
  //   如果物料参数缺失，应该在**一个进程内**秒级报错，而不是起 6 个进程去撞用户的浏览器
  //   再各自失败退出 —— 后者会真的打开 6 个标签页、可能抢到已填好的表单页。
  const need = [];
  if (kind === 'video') {
    if (!material.video) need.push('--video');
    if (!material.bodyFile) need.push('--body-file');
    if (!material.title) need.push('--title');
  } else {
    if (!material.media) need.push('--media');
    if (!material.count) need.push('--count');
    if (!material.bodyFile) need.push('--body-file');
  }
  if (need.length) {
    console.error(
      `\n✗ 缺物料参数：${need.join(' ')}\n` +
        `  这些参数是**必填**的 —— 编排器会并发起多个进程连你的浏览器，\n` +
        `  物料不全就别启动（否则会白开 N 个标签页，还可能抢到你已填好的表单页）。\n\n` +
        `  示例：\n` +
        `    node bin/publish-all.cjs --kind image --media ./cards --count 8 \\\n` +
        `         --title "标题" --body-file body.txt\n`
    );
    process.exit(1);
  }
  // 文件必须真的存在（存在性检查也要在起进程前做）
  for (const [label, p] of [
    ['--body-file', material.bodyFile],
    ['--media', material.media],
    ['--video', material.video],
  ]) {
    if (p && !fs.existsSync(path.resolve(p))) {
      console.error(`\n✗ ${label} 指向的文件不存在：${p}\n`);
      process.exit(1);
    }
  }

  console.log(
    `\n并行填单：${platforms.length} 个平台 · ${kind} 线 · 并发上限 ${args.concurrency ?? 5}\n` +
      `  ⚠ 只填单不发布，**发布由你本人点击**。\n`
  );

  const result = await publishAll({
    platforms,
    kind,
    concurrency: args.concurrency ? Number(args.concurrency) : 5,
    material,
    // 防重复闸门需要内容标识。配了 publish.ledger 时建议传（同一期同一内容只发一次）
    contentKey: args['content-key'] || '',
    allowRepeat: Boolean(args['allow-repeat']),
    onEvent: (e) => {
      if (e.type === 'plan') {
        console.log(`  调度顺序（长任务优先）: ${e.order.join(' → ')}`);
      } else if (e.type === 'start') {
        console.log(`  ▶ ${e.platform} 开始`);
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
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(`\n✗ ${e.message}\n`);
  process.exit(1);
});
