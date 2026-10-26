// lib/manifest.cjs — 平台中立的**发布清单**
//
// ## 为什么需要这个文件
//
// publish-kit 原本的编排接口是「一份物料打所有平台」：
//
//   node bin/publish-all.cjs --kind image --media ./cards --count 8 \
//        --title "标题" --body-file body.txt --platforms douyin,weibo,zhihu
//
// 这套扁平参数回答不了真实发布里的三个问题：
//
//   ① **每个平台的正文不一样**。同一份内容在抖音是 600 字简介、在公众号是 1200 字
//      正文、在知乎想法里标题要并进首行。扁平参数只能给一份正文。
//   ② **每个平台的标题不一样**。视频号标题上限 ≤16 字，是全链路最紧的硬约束；
//      主标题 20 字到视频号必撞墙 → 必须另起一版短标题，**不能截取主标题**
//      （截出来是半句话）。
//   ③ **每个平台的物料组合不一样**。B站要 4:3 + 16:9 两张封面，抖音要竖封面 +
//      横封面，微博视频要 3:4 竖版封面，公众号走 API 不占浏览器。
//
// 所以需要一份**清单**：把「这条内容要发到哪些平台、每个平台填什么」写成数据，
// 由体检、编排、留痕三处读**同一份**（改物料只改这一处）。
//
// ## 它长什么样
//
//   version: 1
//   content:
//     key: "2026-10-26_AI热点速递卡片"     # 防重复闸门用的内容标识
//   variants:                              # 「分发变体」：同一份内容的不同形态
//     image:
//       label: 图文线
//       slots:
//         - platform: douyin
//           kind: image
//           title: "开发者用Codex：改造自家电视"
//           bodyFile: "manuscript/douyin.txt"
//           media: "upload-kit/media"
//           count: 8
//           options:
//             album: "每日新闻"
//             music: "Opus 37"
//         - platform: xiaohongshu
//           via: manual                        # 零自动化，只备料
//           note: "零自动化，仅备料"
//     video:
//       slots:
//         - platform: shipinhao
//           kind: video
//           titleFile: "manuscript/sph-title.txt"   # 平台专属标题变体
//           video: "video/x.mp4"
//           bodyFile: "manuscript/body.txt"
//           covers: ["covers/cover-3x4.png"]
//
// ## 三条设计约定
//
// ① **路径相对清单文件所在目录**（不是相对工作区根）。清单要能随内容目录搬家。
// ② **`via` 表达运行通道**（browser / api / manual），不用 `channel` —— `channel`
//    在微博语境里是「一级频道」，两个含义撞在一起会让清单读起来像 bug。
// ③ **平台专属开关进 `options:`**，不进顶层字段。顶层字段是「跨平台同构」的，
//    `options` 是「这个平台独有的」，两者分开才能既通用又不长出平台私有语法。
//
// ## 与其它模块的关系
//
//   manifest.cjs  →  解析 + 校验 + 展开成「每个槽位跑哪几条命令」
//        ↓
//   publish-all.cjs → 并行编排（长任务优先 + 并发上限 + 重试 + 诊断 + 台账回写）
//        ↓
//   platforms/*.cjs → 实际填单（终点一律「停在发布按钮前」）

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const registry = require('./platforms.cjs');

/** 清单支持的版本 */
const SUPPORTED_VERSION = 1;

/**
 * 平台 → 脚本 → 形态 的映射。
 *
 * ⚠️ **只有抖音是多命令模型**（open→upload→fill→…→shot，每步一个进程、
 *    靠浏览器里那个标签页续上）；其余平台都是「一条命令跑完」。
 *    早期版本这里对抖音只生成了一条不带子命令的命令 → 脚本默认 `cmd='open'`
 *    → **只开了页、没填单，却报成功**。这是本文件存在的另一个理由。
 *
 * 数据源是 lib/platforms.cjs 的**平台注册表**（唯一事实源）—— 这里只做派生，
 * 不要在这里另抄一份平台信息（抄一份必然漂移）。
 */
const PLATFORM_SCRIPTS = Object.fromEntries(
  Object.entries(registry.PLATFORMS).map(([k, p]) => [k, p.script || {}])
);

/** 平台 → 中文名（台账/日志用） */
const PLATFORM_LABELS = Object.fromEntries(
  Object.entries(registry.PLATFORMS).map(([k, p]) => [k, p.label || k])
);

/**
 * 封面槽位 → 各平台的实际位置。
 *
 * 为什么不统一成「一个封面」：B站投稿要 4:3（列表页）与 16:9（首页横卡）两张，
 * 抖音视频要竖封面（3:4）与横封面（4:3）两张，两个平台的第二张用途完全不同。
 * 清单里用**同一份 `covers[]` 数组**按位置取，平台差异收在这张表里。
 */
const COVER_SLOTS = {
  douyin: { video: ['vertical', 'horizontal'] },
  bilibili: { video: ['cover', 'cover16x9'] },
  shipinhao: { video: ['cover'] },
  zhihu: { video: ['cover'] },
  weibo: { video: ['cover'] },
};

/** 封面槽位 → 命令行参数名 */
const COVER_FLAGS = {
  douyin: { vertical: '--vertical', horizontal: '--horizontal' },
  bilibili: { cover: '--cover', cover16x9: '--cover-16x9' },
  shipinhao: { cover: '--cover' },
  zhihu: { cover: '--cover' },
  weibo: { cover: '--cover' },
};

/**
 * 平台专属开关 → 命令行参数。
 *
 * ⚠️ 这里是**白名单**：清单里写了表外的开关 → 直接报错，不静默丢掉。
 *    静默丢掉会让人以为「配了生效了」，而实际没填 —— 这类静默失效最难查。
 */
const OPTION_FLAGS = {
  douyin: {},
  weibo: { channel: '--channel', sub: '--sub' },
  zhihu: { field: '--field' },
  shipinhao: { album: '--album', location: '--location' },
  bilibili: {},
  wechat: {},
};

/**
 * **步骤级**开关：不是命令行参数，而是「哪个子命令负责它」。
 *
 * 抖音的合集与配乐就是这种：它们各自是独立子命令（`collect` / `music`），
 * 不是主命令上的一个 flag。如果把它们也当普通 flag 拼到第一条命令上，
 * 那个参数就会被带到一个根本不读它的命令里 —— 看起来「配了」，实际没生效。
 */
const STEP_OPTIONS = {
  douyin: { album: 'collect', music: 'music' },
  weibo: {},
  zhihu: {},
  shipinhao: {},
  bilibili: {},
  wechat: {},
};

/** 不带值的开关（末尾追加，避免吞掉下一个参数） */
const VALUE_LESS_OPTIONS = {
  douyin: {},
  weibo: { no_declare: '--no-declare' },
  zhihu: { title_in_body: '--title-in-body', manual_images: '--manual-images' },
  bilibili: {},
  shipinhao: {},
  wechat: {},
};

/** 运行通道 */
const VIA = { BROWSER: 'browser', API: 'api', MANUAL: 'manual' };

/**
 * 各平台形态硬限制（**无实测依据的不要放进来** —— 见 capability-matrix 的「软线」纪律）。
 * 数据源：lib/platforms.cjs 的平台注册表。
 */
const DEFAULT_LIMITS = Object.fromEntries(
  Object.entries(registry.PLATFORMS).map(([k, p]) => [
    k,
    Object.fromEntries(
      Object.entries(p.limits || {}).map(([kind, lim]) => [kind, { ...lim }])
    ),
  ])
);

/** 某平台的某形态的默认限制 */
function limitsFor(platform, kind) {
  return { ...(DEFAULT_LIMITS[platform]?.[kind] || {}) };
}

class ManifestError extends Error {}

/* ──────────────────────────────────────────────────────────────
   解析
   ────────────────────────────────────────────────────────────── */

/** 读清单文件 */
function loadManifest(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new ManifestError(
      `找不到发布清单：${abs}\n   用法：node bin/publish-manifest.cjs <清单.yaml> [--dry-run]`
    );
  }
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(abs, 'utf8')) || {};
  } catch (e) {
    throw new ManifestError(`发布清单解析失败（${abs}）：${e.message}`);
  }
  if (doc.version === undefined) doc.version = SUPPORTED_VERSION;
  if (Number(doc.version) !== SUPPORTED_VERSION) {
    throw new ManifestError(
      `发布清单版本不支持：version=${doc.version}（本工具支持 ${SUPPORTED_VERSION}）`
    );
  }
  doc.__baseDir = path.dirname(abs);
  doc.__file = abs;
  return doc;
}

/** 清单里的相对路径 → 绝对路径（绝对路径原样返回） */
function resolvePath(baseDir, p) {
  if (!p) return '';
  const s = String(p).trim();
  if (!s) return '';
  if (path.isAbsolute(s)) return s;
  return path.resolve(baseDir, s);
}

/** 读一个「文件即内容」的字段（标题变体 / 标签文件） */
function readTextFile(baseDir, rel) {
  const abs = resolvePath(baseDir, rel);
  if (!abs) return '';
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8').trim();
}

/**
 * 把文档展开成「变体 → 槽位数组」。
 *
 * 两种写法都支持：
 *   · `variants: { image: { slots: [...] } }`  —— 同一份内容的多种形态
 *   · `slots: [...]`（顶层平铺）—— 单一形态时的简写
 */
function normalize(doc) {
  const baseDir = doc.__baseDir || process.cwd();
  const content = doc.content || {};
  const variants = {};

  if (doc.variants && typeof doc.variants === 'object') {
    for (const [name, v] of Object.entries(doc.variants)) {
      variants[name] = {
        name,
        label: (v && v.label) || name,
        slots: normalizeSlots(v && v.slots, baseDir, name),
      };
    }
  }
  if (Array.isArray(doc.slots)) {
    const name = 'default';
    variants[name] = { name, label: '默认', slots: normalizeSlots(doc.slots, baseDir, name) };
  }
  if (!Object.keys(variants).length) {
    throw new ManifestError('发布清单里没有槽位：至少要有 `variants: { <名>: { slots: [...] } }` 或顶层 `slots: [...]`');
  }
  return {
    file: doc.__file || '',
    baseDir,
    content: {
      key: String(content.key || '').trim(),
      domain: String(content.domain || '').trim(),
    },
    defaults: doc.defaults || {},
    variants,
  };
}

function normalizeSlots(list, baseDir, variantName) {
  if (!Array.isArray(list)) return [];
  return list.map((s, i) => {
    const slot = { ...s };
    slot.__index = i;
    slot.__variant = variantName;
    slot.__baseDir = baseDir;
    return slot;
  });
}

/* ──────────────────────────────────────────────────────────────
   槽位展开
   ────────────────────────────────────────────────────────────── */

/** 顶层默认值与槽位值合并（槽位优先；顶层只提供「跨平台同构」的默认值） */
function mergeDefaults(slot, defaults) {
  const out = { ...defaults, ...slot };
  // options 是要**合并**而不是覆盖的：defaults 里的 album 与槽位里的 music 应该共存
  out.options = { ...(defaults.options || {}), ...(slot.options || {}) };
  return out;
}

/**
 * 展开一个槽位：读标题变体文件 / 标签文件、解析路径、算出平台形态与限制。
 *
 * @returns {Object} 展开后的槽位（新增字段都带 `__` 前缀或明确命名）
 */
function resolveSlot(slot, defaults = {}) {
  const baseDir = slot.__baseDir || process.cwd();
  const merged = mergeDefaults(slot, defaults);

  const platform = String(merged.platform || '').trim();
  const kind = String(merged.kind || 'image').trim();
  const via = String(merged.via || (platform === 'wechat' ? VIA.API : VIA.BROWSER)).trim();

  // 标题：**内联 > 标题变体文件**。标题变体文件是「另起一版」的独立标题，
  // 不是主标题的截断 —— 截出来的半句话比撞上限更糟。
  let title = merged.title != null ? String(merged.title) : '';
  let titleFromFile = '';
  if (merged.titleFile) {
    titleFromFile = readTextFile(baseDir, merged.titleFile);
    if (titleFromFile) title = titleFromFile;
  }

  // 标签：内联数组 / 逗号串 / 标签文件，三种都收
  let tags = '';
  if (Array.isArray(merged.tags)) tags = merged.tags.join(',');
  else if (merged.tags) tags = String(merged.tags);
  if (merged.tagsFile) {
    const t = readTextFile(baseDir, merged.tagsFile);
    if (t) tags = t;
  }

  const covers = Array.isArray(merged.covers) ? merged.covers : merged.cover ? [merged.cover] : [];

  return {
    // 标识
    platform,
    label: merged.label || PLATFORM_LABELS[platform] || platform,
    kind,
    via,
    variant: slot.__variant || 'default',
    index: slot.__index ?? 0,
    // 物料
    title,
    titleFromFile: titleFromFile ? String(merged.titleFile) : '',
    bodyFile: resolvePath(baseDir, merged.bodyFile),
    bodyFileRel: merged.bodyFile || '',
    media: resolvePath(baseDir, merged.media),
    mediaRel: merged.media || '',
    count: merged.count != null ? Number(merged.count) : undefined,
    video: resolvePath(baseDir, merged.video),
    videoRel: merged.video || '',
    cover: resolvePath(baseDir, merged.cover),
    coverRel: merged.cover || '',
    vertical: resolvePath(baseDir, merged.vertical),
    horizontal: resolvePath(baseDir, merged.horizontal),
    cover16x9: resolvePath(baseDir, merged.cover16x9),
    covers: covers.map((c) => resolvePath(baseDir, c)),
    coversRel: covers,
    tags,
    tagsFile: merged.tagsFile ? resolvePath(baseDir, merged.tagsFile) : '',
    // 平台专属
    options: merged.options || {},
    // 限制
    limits: { ...limitsFor(platform, kind), ...(merged.limits || {}) },
    // 人工交割用
    releaseFile: merged.releaseFile ? resolvePath(baseDir, merged.releaseFile) : '',
    note: merged.note || '',
    exclusive: merged.exclusive === true,
    weight: Number(merged.weight) > 0 ? Number(merged.weight) : undefined,
    // 原始
    raw: merged,
    baseDir,
  };
}

/* ──────────────────────────────────────────────────────────────
   校验
   ────────────────────────────────────────────────────────────── */

/**
 * 校验一个展开后的槽位。
 *
 * 契约：**FAIL = 不能执行**（缺物料、文件不存在、平台不认识）。
 *       WARN = 能执行但要提醒（如标题超长、标签没配）。
 *
 * ⚠️ 校验**不碰浏览器** —— 可以在起 Chrome 之前全部跑完。
 */
function validateSlot(s) {
  const fail = [];
  const warn = [];

  if (!s.platform) {
    fail.push('槽位缺 platform');
    return { fail, warn };
  }

  // 人工通道（零自动化）：**不要求平台在注册表里**。
  // 很多账号对某些平台就是「不自动化，只备料」，那些平台未必是本工具支持的平台。
  // 但它必须**显式声明** via: manual —— 漏声明会被下面的「不认识平台」拦下来，
  // 免得把「零自动化」变成「忘了配」。
  if (s.via === VIA.MANUAL) {
    if (!s.releaseFile && !s.note) {
      warn.push(`槽位 ${s.platform} 是 manual 通道 —— 请给 releaseFile 或 note，说明人工要做什么`);
    }
    return { fail, warn };
  }

  if (!PLATFORM_SCRIPTS[s.platform]) {
    fail.push(
      `不认识的平台 ${s.platform}（本工具支持：${Object.keys(PLATFORM_SCRIPTS).join(', ')}）。\n` +
        `    若该平台走**零自动化**，请在清单里显式写 via: manual（只备料，不执行任何自动化）。`
    );
    return { fail, warn };
  }
  const script = PLATFORM_SCRIPTS[s.platform][s.kind];
  if (!script) {
    fail.push(`平台 ${s.platform} 没有 ${s.kind} 形态的脚本`);
    return { fail, warn };
  }
  if (![VIA.BROWSER, VIA.API, VIA.MANUAL].includes(s.via)) {
    fail.push(`槽位 ${s.platform} 的 via=${s.via} 不合法（browser | api | manual）`);
  }

  // 必填物料
  if (s.platform === 'wechat') {
    if (!s.media) fail.push('公众号缺 media（图集目录）');
    if (!s.title) fail.push('公众号缺 title');
    if (!s.bodyFile) fail.push('公众号缺 bodyFile');
  } else if (s.kind === 'video') {
    if (!s.video) fail.push(`${s.platform} 视频线缺 video`);
    if (!s.title) fail.push(`${s.platform} 视频线缺 title`);
    if (!s.bodyFile) fail.push(`${s.platform} 视频线缺 bodyFile`);
  } else {
    // 图文线
    if (!s.media) fail.push(`${s.platform} 图文线缺 media`);
    if (s.platform !== 'zhihu' && !s.title) fail.push(`${s.platform} 图文线缺 title`);
    if (!s.bodyFile) fail.push(`${s.platform} 图文线缺 bodyFile`);
    if (s.platform === 'douyin' && !s.count) fail.push('抖音图文缺 count（要传几张）');
  }

  // 文件存在性
  for (const [label, p] of [
    ['bodyFile', s.bodyFile],
    ['video', s.video],
    ['cover', s.cover],
    ['vertical', s.vertical],
    ['horizontal', s.horizontal],
    ['cover16x9', s.cover16x9],
  ]) {
    if (p && !fs.existsSync(p)) fail.push(`${label} 指向的文件不存在：${p}`);
  }
  if (s.media && !fs.existsSync(s.media)) fail.push(`media 目录不存在：${s.media}`);
  if (s.media && s.count) {
    const usable = listMediaFiles(s.media).length;
    if (usable < s.count) {
      fail.push(
        `图集不足：声称要传 ${s.count} 张，${s.media} 里只有 ${usable} 张可用图` +
          `（宁可不发，也不发错 —— 这正是「三个平台各只传 1 张、判据却全通过」那次事故的根因）`
      );
    }
  }

  // 标题长度
  if (s.title && s.limits.titleMax && [...s.title].length > s.limits.titleMax) {
    const isHard = s.platform === 'shipinhao';
    const msg = `标题 ${[...s.title].length} 字 > 上限 ${s.limits.titleMax}：${s.title}`;
    if (isHard) fail.push(msg + '（视频号短标题 ≤16 字是硬约束，请给 titleFile 另起一版短标题，不要截取主标题）');
    else warn.push(msg);
  }
  if (s.title && !s.titleFromFile && s.platform === 'shipinhao') {
    warn.push('视频号建议用 titleFile 给一版 ≤16 字的独立短标题');
  }

  // 标签（B站不传直接报错）
  if (s.platform === 'bilibili' && !s.tags) {
    fail.push('B站缺 tags（B站脚本不传标签会直接报错 —— 不默认标签）');
  }

  // 未知的 options → FAIL（不静默丢）
  const known = {
    ...OPTION_FLAGS[s.platform],
    ...VALUE_LESS_OPTIONS[s.platform],
    ...STEP_OPTIONS[s.platform],
  };
  for (const k of Object.keys(s.options || {})) {
    if (!(k in known)) {
      fail.push(
        `平台 ${s.platform} 不认识开关 options.${k}` +
          `（可用：${Object.keys(known).join(', ') || '（无）'}）—— 静默丢掉会让人以为配了生效了`
      );
    }
  }

  return { fail, warn };
}

/**
 * 列一个目录里的可用图片（按序号归一后的张数）。
 * 与 lib/preflight.cjs 的 listImages 同源语义，但**不依赖那个模块**——
 * manifest 校验要在 preflight 之前跑，preflight 是抛错式的，不适合被当工具函数用。
 */
function listMediaFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort();
  const byName = new Map();
  for (const f of files) {
    let m = f.match(/^img[-_](\d+)/i);
    if (!m) m = f.match(/^(\d+)/);
    if (!m) {
      const all = [...f.matchAll(/(\d+)/g)];
      if (all.length) m = { 1: all[all.length - 1][1] };
    }
    if (!m) continue;
    const key = String(Number(m[1])).padStart(2, '0');
    byName.set(key, f);
  }
  return [...byName.keys()].sort();
}

/* ──────────────────────────────────────────────────────────────
   命令展开
   ────────────────────────────────────────────────────────────── */

/**
 * 把一个槽位展开成「要依次跑哪几条命令」。
 *
 * 每条命令 = { script, args, label, idempotent }。编排层逐条 spawn，**按顺序**执行。
 *
 * ⚠️ 抖音是唯一的多命令平台：它的每个子命令是**一个独立进程**，
 *    靠「浏览器里那个标签页」续上下文（open 时写入 sessionStorage.dyKind 标记）。
 *    所以这组命令必须**按序**跑，不能并发、不能乱序。
 *
 * ⚠️ `idempotent: false` 的步骤**不允许自动重试** —— 重跑「上传素材」可能把
 *    素材传成两份（上传队列已经收了第一份，只是后续步骤超时了）。
 *    宁可报出来让人判断，也不要静默传两遍。
 */
function planCommands(s) {
  const script = PLATFORM_SCRIPTS[s.platform]?.[s.kind];
  if (!script) return [];
  const cmds = [];
  const push = (label, args, idempotent = true) => cmds.push({ script, args, label, idempotent });
  // 只在值「有内容」时追加参数 —— 缺了就让脚本自己报缺什么，
  // 而不是把 undefined 当字符串塞进去（那会让报错信息变得莫名其妙）。
  const arg = (a, flag, v) => {
    if (v === undefined || v === null || v === '') return a;
    a.push(flag, String(v));
    return a;
  };

  switch (s.platform) {
    case 'douyin': {
      push('打开上传页', ['open', '--kind', s.kind]);
      if (s.kind === 'video') {
        push('上传视频', ['upload', '--kind', s.kind, '--file', s.video].filter(Boolean), false);
      } else {
        const a = ['upload', '--kind', s.kind];
        arg(a, '--media', s.media);
        arg(a, '--count', s.count);
        push('上传图集', a, false);
      }
      const fillArgs = ['fill', '--kind', s.kind];
      arg(fillArgs, '--title', s.title);
      arg(fillArgs, '--body-file', s.bodyFile);
      push('填标题与正文', fillArgs);
      if (s.kind === 'video') {
        const c = ['cover', '--kind', s.kind];
        arg(c, '--vertical', s.vertical);
        arg(c, '--horizontal', s.horizontal);
        if (s.vertical || s.horizontal) push('设置双封面', c);
      }
      if (s.options.music && s.kind === 'image') {
        push('选配乐', ['music', '--kind', s.kind, '--music', String(s.options.music)]);
      }
      if (s.options.album) {
        push('选合集与自主声明', ['collect', '--kind', s.kind, '--album', String(s.options.album)]);
      }
      push('截图留档', ['shot', '--kind', s.kind]);
      break;
    }

    case 'weibo': {
      if (s.kind === 'video') {
        const a = [];
        arg(a, '--video', s.video);
        arg(a, '--body-file', s.bodyFile);
        arg(a, '--title', s.title);
        arg(a, '--cover', s.cover);
        push('填视频投稿表单', a);
      } else {
        const a = [];
        arg(a, '--media', s.media);
        arg(a, '--count', s.count);
        arg(a, '--body-file', s.bodyFile);
        arg(a, '--title', s.title);
        push('填图文投稿表单', a);
      }
      break;
    }

    case 'zhihu': {
      if (s.kind === 'video') {
        const a = [];
        arg(a, '--video', s.video);
        arg(a, '--title', s.title);
        arg(a, '--body-file', s.bodyFile);
        arg(a, '--cover', s.cover);
        push('填视频投稿表单', a);
      } else {
        const a = [];
        arg(a, '--media', s.media);
        arg(a, '--count', s.count);
        arg(a, '--body-file', s.bodyFile);
        arg(a, '--title', s.title);
        push('填想法', a);
      }
      break;
    }

    case 'bilibili': {
      const a = [];
      arg(a, '--video', s.video);
      arg(a, '--title', s.title);
      arg(a, '--body-file', s.bodyFile);
      if (s.tagsFile) a.push('--tags-file', s.tagsFile);
      else if (s.tags) a.push('--tags', s.tags);
      arg(a, '--cover', s.cover);
      arg(a, '--cover-16x9', s.cover16x9);
      push('填投稿表单', a);
      break;
    }

    case 'shipinhao': {
      const a = [];
      arg(a, '--video', s.video);
      arg(a, '--title', s.title);
      arg(a, '--body-file', s.bodyFile);
      arg(a, '--cover', s.cover);
      push('填发表视频表单', a);
      break;
    }

    case 'wechat': {
      const a = ['push'];
      arg(a, '--media', s.media);
      arg(a, '--count', s.count);
      arg(a, '--title', s.title);
      arg(a, '--body-file', s.bodyFile);
      push('推草稿箱', a);
      break;
    }
    default:
      break;
  }

  // 平台专属开关（白名单；未知项在 validateSlot 里已 FAIL）
  const flagMap = OPTION_FLAGS[s.platform] || {};
  const valueless = VALUE_LESS_OPTIONS[s.platform] || {};
  const first = cmds[0];
  if (first) {
    for (const [k, v] of Object.entries(s.options || {})) {
      if (flagMap[k]) first.args.push(flagMap[k], String(v));
    }
    // 不带值的开关放最后：避免它把下一个参数当成自己的值吞掉
    for (const [k, v] of Object.entries(s.options || {})) {
      if (valueless[k] && v !== false) first.args.push(valueless[k]);
    }
  }

  return cmds;
}

/* ──────────────────────────────────────────────────────────────
   组装
   ────────────────────────────────────────────────────────────── */

/**
 * 读清单 → 展开成「可执行的槽位列表」。
 *
 * @param {string} file 清单路径
 * @param {Object} opts
 * @param {string[]} [opts.variants] 只要这几个变体（默认全要）
 * @param {string[]} [opts.only] 只要这几个平台
 * @param {Function} [opts.onWarn] (msg) => void
 * @returns {Object} { content, baseDir, slots: [{...slot, commands:[...]}], problems: {fail,warn} }
 */
function buildPlan(file, opts = {}) {
  const doc = loadManifest(file);
  const norm = normalize(doc);
  const wantVariants = opts.variants && opts.variants.length ? opts.variants : null;
  const wantPlatforms = opts.only && opts.only.length ? new Set(opts.only) : null;

  const slots = [];
  const problems = { fail: [], warn: [] };

  for (const [vname, v] of Object.entries(norm.variants)) {
    if (wantVariants && !wantVariants.includes(vname)) continue;
    for (const raw of v.slots) {
      const s = resolveSlot(raw, norm.defaults);
      s.variantLabel = v.label;
      if (wantPlatforms && !wantPlatforms.has(s.platform)) continue;
      const chk = validateSlot(s);
      if (chk.fail.length) {
        problems.fail.push(...chk.fail.map((m) => `[${vname}/${s.platform}] ${m}`));
        continue; // 校验不过就不进执行计划
      }
      problems.warn.push(...chk.warn.map((m) => `[${vname}/${s.platform}] ${m}`));
      s.commands = planCommands(s);
      slots.push(s);
    }
  }

  return {
    file: norm.file,
    baseDir: norm.baseDir,
    content: norm.content,
    variants: Object.fromEntries(
      Object.entries(norm.variants).map(([k, v]) => [k, { label: v.label, count: v.slots.length }])
    ),
    slots,
    problems,
  };
}

module.exports = {
  SUPPORTED_VERSION,
  VIA,
  PLATFORM_SCRIPTS,
  PLATFORM_LABELS,
  COVER_SLOTS,
  COVER_FLAGS,
  OPTION_FLAGS,
  VALUE_LESS_OPTIONS,
  STEP_OPTIONS,
  DEFAULT_LIMITS,
  limitsFor,
  ManifestError,
  loadManifest,
  normalize,
  resolveSlot,
  validateSlot,
  planCommands,
  buildPlan,
  resolvePath,
  listMediaFiles,
};
