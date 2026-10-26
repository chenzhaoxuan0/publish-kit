# publish-kit

多平台图文 / 视频**自动填单**工具集。填完停在「发布」按钮前，**发布由你本人点击**。

支持 9 条通道：

| 线 | 平台 | 脚本 |
|---|---|---|
| 视频 | 抖音 / B站 / 知乎 / 微博 / 视频号 | `douyin.cjs --kind video` · `bilibili.cjs` · `zhihu.cjs` · `weibo.cjs` · `shipinhao.cjs` |
| 图文 | 抖音 / 微博 / 知乎想法 / 公众号贴图 | `douyin.cjs --kind image` · `weibo-image.cjs` · `zhihu-pin.cjs` · `wechat.cjs` |

---

## 🚦 第一步永远是 init —— 不初始化，任何脚本都跑不起来

**没有 `config.yaml` 时，所有平台脚本会立刻报错退出。** 这是刻意设计的：
脚本需要知道你的 CDP 地址、浏览器 profile、内容领域、各平台分区，这些无法猜。

```bash
npm install
node bin/init.cjs        # ← 必须先跑这个，回答几个问题，生成 config.yaml
node bin/doctor.cjs      # ← 体检：浏览器 / CDP / 各平台登录态
node bin/login.cjs       # ← 打开要登录的平台，扫码
node bin/doctor.cjs      # ← 复核
```

`init` 会问：CDP 端口、profile 目录、你的内容领域、启用哪些平台、各平台分区/合集、公众号凭证。
回答完就生成 `config.yaml`（该文件已进 `.gitignore`，别提交）。

> **给 AI agent 用这个包的话**：请读 [`AGENTS.md`](AGENTS.md)，里面有决策流程与踩坑清单，
> 比读 README 快得多。**任何情况下不要跳过 `init` 直接跑平台脚本。**

---

## 🤖 Agent skill

仓库里带了一个可直接安装的 skill，让 AI agent 按**正确顺序**调用本工具：

```
skills/publish-kit/
├── SKILL.md                      决策流程 + 红线 + 命令速查
├── references/
│   ├── commands.md               完整命令面（每平台参数 / 用法 / 坑位）
│   └── troubleshooting.md        排障详表
└── INSTALL.md                    安装说明
```

装法（详见 `skills/publish-kit/INSTALL.md`）：

```bash
# 从仓库
git clone https://github.com/chenzhaoxuan0/publish-kit.git && cd publish-kit && npm install
cp -r skills/publish-kit ~/.minimax/agents/mavis/skills/    # mavis
# 或 ~/.claude/skills/ 等你的 agent 的 skills 目录

# 从 npm
npm install -g publish-kit
cp -r "$(npm root -g)/publish-kit/skills/publish-kit" ~/.minimax/agents/mavis/skills/
```

skill 的价值不在「教会模型敲命令」，而在**固化三条容易被忽略的东西**：

1. **红线** —— 绝不点发布、绝不自动登录、绝不替用户猜分区/合集
2. **顺序** —— 先 `doctor` 查登录态再填单；重跑前先看交割护栏（别急着加 `--force`）
3. **判据** —— 平台改版时的排查路径（先读脚本头坑位注释，再写探针抓地面真相，
   别靠反复实跑试探）

> 它和 [`AGENTS.md`](AGENTS.md) 是同一套知识的两种形态：
> `AGENTS.md` 给人读（更全），skill 给 agent 读（更聚焦「怎么用」）。

---

## ⚠️ 先读这一段：这是个参考实现，不是开箱即用的库

请在决定用之前先接受下面三点，否则你会在第二次运行时放弃：

1. **平台的选择器是写死的中文字符串。** 各平台改版会导致填单失败，需要自己改选择器。
   这是浏览器自动化填表的固有问题，不是本项目的疏漏。这个包的价值在于
   **把踩过的坑和解决方案都写在了注释里**，而不是替你省掉改代码。

2. **它是为「中文界面 + 单账号」场景写的。** 英文界面跑不通。多账号矩阵需要改造。

3. **平台改版频率高。** 本包的代码在真实平台上反复验证过，但没有任何办法让它永远不过期。
   如果你要长期用，请把它 fork 走，而不是直接依赖。

如果你需要的是「装上就能用、永远不用改」的发布工具，这个包不适合你。

---

## 设计上的三条硬契约

这三条是这个包真正的价值来源，它们不是 best practice，是被实际问题逼出来的设计。

### 1. 绝不点击「发布」

所有脚本的终点都是「表单已填好 + 截图留档 + 停在发布按钮前」。

这不只是谨慎，是架构上的选择：把「AI 误发」从技术问题变成了架构上不可能发生的事。
没有哪个环节能点到发布按钮，因为代码里没有那条路径。

公众号走官方 API，但**只推草稿箱**，不调用任何发布类接口。

### 2. 留空 ≠ 猜一个默认值

所有平台字段（分区 / 分类 / 合集 / 领域）都是：**没配置就跳过 + 控制台告警**。

```
⚠  跳过 B站分区（platforms.bilibili.category_hint 未配置）—— 已在发布页留空，发布前请手动选择。
   补法：编辑 config.yaml，或跑 node bin/init.cjs 重新生成。
```

为什么不提供默认值？因为这些脚本的终点是「停在发布前让用户点」。如果脚本猜了一个分区填上去，
用户在发布前不一定会发现，结果就是一条带着错误分类的内容发出去了。
**留空时的那行告警是一次明确提醒，成本远低于发错。**

平台自身的硬限制（标题字数、图片张数上限等）是另一回事，那些会保留并在注释里注明来源。

### 3. 填完即交割

脚本启动时会先检测目标表单是否已有内容，有就**拒绝执行**，必须显式 `--force` 才能重填。

原因是这些平台的表单内容只存在于页面内存里，一次误导航或误刷新就会全部丢失，
而用户可能已经接管这个页面在补信息了。

---

## 横向能力层

各平台脚本只管「这个平台怎么填」，通用能力抽在 `lib/` 里。

| 模块 | 做什么 | 为什么有它 |
|---|---|---|
| `lib/wait.cjs` | `waitFor` 条件等待 · `humanDelay` 随机节奏 · `fillLongText` 一次性长文本插入 · `pickFileWithRetry` 上传重试 | 以前每个平台各写各的 `sleep()` 和轮询循环，间隔还不统一（1500/2000/3000 都有）。**固定等待等不够就往下走 → 后续动作落空；等太久就是白等。** |
| `lib/log.cjs` | 每平台一份独立日志：带时间戳每一步 + 收尾的**步骤耗时倒序表** + 告警汇总 | 慢在哪不该靠猜 |
| `lib/preflight.cjs` | **起浏览器之前**的体检：图集张数 vs 实际、正文长度区间、违禁内容、标题长度 | 见下面「判据的前提」 |
| `lib/ledger.cjs` | 可选发布台账 + **防重复发布闸门** | 「绝不重复发布」需要跨进程、跨期的事实源 |
| `lib/publish-all.cjs` | 并行编排器：长任务优先调度 + 并发上限 | 见下面「并行」 |
| `lib/manifest.cjs` | **平台中立发布清单**：每个平台用自己的标题/正文/封面/标签 | 见下面「发布清单」 |
| `lib/diagnose.cjs` | 失败自动诊断：把失败分成 6 级，每级给一条可执行建议 | 「失败之后该干什么」不该靠人肉翻日志 |
| `lib/shot.cjs` | 截图降级为告警：6s 短路超时、**永不抛异常** | 截图是留档，判据全在 DOM —— 截图失败不该让整轮发布作废 |
| `lib/platforms.cjs` | **平台注册表**（唯一事实源）：形态 / 脚本 / 登录判据 / 实测耗时 / 限制 | 平台信息散在 4 处 → 漏改一处就静默失效 |
| `lib/platform-urls.cjs` | 平台↔链接域名闸 + 匿名 GET 核验 | 链接贴错格子会被预填链路**反复复活** |
| `lib/bigfile-upload.cjs` | >48MB 视频走 CDP 原生直传 | 见下面「大文件」 |

### 发布清单（每个平台用自己的物料）

「一份物料打所有平台」回答不了真实发布：抖音 600 字简介 / 公众号 1200 字正文 /
知乎想法标题并进首行 / 视频号标题 ≤16 字（必须**另起一版**，截主标题会截出半句话）/
B站要 4:3 + 16:9 两张封面而抖音要竖封面 + 横封面。

**发布清单**把「这条内容要发到哪些平台、每个平台填什么」写成数据，体检、编排、留痕读**同一份**：

```bash
node bin/publish-manifest.cjs publish.yaml            # 按清单填单
node bin/publish-manifest.cjs publish.yaml --dry-run  # 只打印将要跑什么
node bin/publish-manifest.cjs publish.yaml --check-only  # 只体检，不起浏览器
node bin/publish-manifest.cjs publish.yaml --variants image --only douyin,zhihu
```

```yaml
version: 1
content:
  key: "2026-10-26_AI热点速递卡片"   # 防重复闸门的内容标识
variants:                            # 分发变体：同一份内容的不同形态
  image:
    slots:
      - platform: douyin
        kind: image
        title: "开发者用Codex：改造自家电视"
        bodyFile: "manuscript/douyin.txt"
        media: "upload-kit/media"
        count: 8
        options: { album: "每日新闻", music: "Opus 37" }
      - platform: xiaohongshu
        via: manual                        # 零自动化，只备料
        note: "零自动化，仅备料"
  video:
    slots:
      - platform: shipinhao
        kind: video
        titleFile: "manuscript/sph-title.txt"   # 平台专属标题变体（另起一版）
        video: "video/release.mp4"
        covers: ["covers/cover-3x4.png"]
```

完整字段表见 [`docs/manifest.example.yaml`](docs/manifest.example.yaml)。

四条约定：

1. **路径相对清单文件所在目录**（不相对工作区根）—— 清单要能随内容目录搬家
2. **`via` 表达运行通道**（`browser` / `api` / `manual`），**不用 `channel`** ——
   `channel` 在微博语境里是「一级频道」，两个含义撞在一起会让清单读起来像 bug
3. **平台专属开关进 `options:`**；写表外的开关**直接报错**，不静默丢
4. **未知平台必须显式写 `via: manual`** —— 漏声明会被拦下来，
   免得把「零自动化」变成「忘了配」

### 失败之后该干什么

平台脚本失败时，编排层会自动诊断并给一条**可执行**建议：

| 级别 | 含义 | 自动重试？ |
|---|---|---|
| `channel-dead` | 通道整体不可用（导航 / 执行上下文 / CDP） | ❌ 先修通道，别再填单 |
| `login-required` | 登录态失效 / 公众号凭证与 IP 白名单 | ❌ 让用户扫码 |
| `content-rejected` | 素材或文案被平台拒 | ❌ 改物料 |
| `cosmetic` | 只是截图失败 | ✅ 填单其实已经成了 |
| `retryable` | 偶发失败（超时 / 点击没生效） | ✅ 重跑一次 |
| `unknown` | 认不出来 | ❌ 给人看 |

自动重试**只重跑失败的那一步**，且该步必须幂等（重新上传素材那一步不幂等 → 不重跑）；
**API 通道（公众号永久素材）永不自动重跑**。

### 判据的前提是 count 本身对

任何「上传后确认成功」的自动化，判据只能证明**页面上的东西**，证明不了**喂进去的东西**。

真实事故：某平台的图集列表只列了 1 张 → count=1 → 三个平台各只传了 1 张图，
而每个平台的判据都「通过」了（`渲染张数 ≥ count`，1 ≥ 1 恒成立）——
脚本报成功、语气笃定，结果三个平台全是残缺图集。

→ **起浏览器之前**先核对「声明要传几张」与「目录里真有几张」，不过就不执行。
宁可不发，也不发错。

### 并行

```bash
node bin/publish-all.cjs --platforms douyin,weibo,zhihu --kind image \
     --media ./cards --count 8 --title "标题" --body-file body.txt
```

实测（8 图 + 视频素材，9 平台）：**串行 613.1s → 并行 120.7s 墙钟**。

两条从实测里长出来的规则：

1. **长任务优先调度** —— 按各平台实测耗时从大到小先发。否则并发有上限时，
   墙钟 ≈「最慢的排最后」那个，而不是最慢平台本身的耗时。
2. **默认并发上限 5** —— 9 全并发会触发**平台侧限流**：同账号并发上传时，
   知乎的图集一直只上到 7 张（补传还会把重复图当成第 8 张 → 图集区只有 7 张）。
   实测降到 5 反而更快（145.6s → 120.7s）且 9/9 成功。
   要一把梭用 `--concurrency 99`（自己承担限流风险）。

### 速度优化：长文本一次性插入

逐字 `keyboard.type` 每敲一个字符都是一次 CDP 往返，N 个字符 = N 次往返。
实测 958 字简介：逐块 type 要 12s，`insertText` 约 0.6s，**省约 11s**。

⚠️ `insertText` **不保证触发编辑器的 input 事件** —— 有些编辑器（React 受控）
会「看起来插进去了但 state 没收到」。所以 `fillLongText` 一律**回读校验**，
对不上就**自动退回**逐块输入，不把半截正文交割出去。

### 可选：防重复发布台账

```yaml
publish:
  ledger: "./publish-ledger.yaml"    # 不配 = 零行为变化
```

配了之后，`node bin/publish-all.cjs --content-key "2026-10-21_xxx#video"` 会在
**起浏览器之前**查台账：这条内容在某个平台已是 `manual-handoff`（已填完交给你、等你点发布）
或 `published`（已发布）就**挡住**，除非显式 `--allow-repeat`。

页面态护栏挡不住这些：昨天发过这一期、填完交给你还没点、上次失败重跑。

---

## 常用命令

```bash
# 单平台（原有用法不变）
node platforms/douyin.cjs --kind image --media ./cards --count 8 --title "标题" --body-file body.txt
node platforms/bilibili.cjs --video a.mp4 --title "标题" --body-file desc.txt --tags "AI,大模型" --cover c.png

# 多平台并行（一条命令）
node bin/publish-all.cjs --platforms douyin,weibo,zhihu --kind image \
     --media ./cards --count 8 --title "标题" --body-file body.txt
node bin/publish-all.cjs --platforms douyin,weibo,zhihu,bilibili,shipinhao --kind video \
     --video a.mp4 --title "标题" --body-file desc.txt --cover c.png --concurrency 5

# 发布清单（每个平台用自己的物料）—— 推荐
node bin/publish-manifest.cjs publish.yaml
node bin/publish-manifest.cjs publish.yaml --dry-run
node bin/publish-manifest.cjs publish.yaml --check-only

# 自检（改完 lib/ 跑一次）
node selftest.cjs
```

⚠️ `publish-all` **物料不全会秒级报错且不启动任何平台脚本** —— 它会并发起 N 个进程连你的浏览器，
物料不全就别启动（否则白开 N 个标签页，还可能抢到你已填好的表单页）。

---

## 快速开始

```bash
npm install

node bin/init.cjs        # 问几个问题，生成 config.yaml
node bin/doctor.cjs      # 体检：浏览器、CDP、各平台登录态
node bin/login.cjs       # 打开要登录的平台，等你扫码
node bin/doctor.cjs      # 复核登录态
```

`doctor` 会自动探测 Chrome 路径、拉起浏览器、逐个平台检查登录态。
它是主动的——你不用跑到某个脚本报错才知道要登录。加 `--no-launch` 则完全不碰浏览器
（CI，或你正在用同一个 Chrome 干别的、不想被打扰时用）。

> ⚠️ **`runtime.profile_dir` 目录（默认 `~/.publish-profile`）里是你所有平台的登录凭据。**
> 那相当于各平台的 cookie / token，泄露等于交出账号。别放进网盘同步目录，别提交到 git，
> 别给不受信任的进程访问。

### 平台配置

`config.yaml` 由 `init` 生成，各平台字段留空即「跳过 + 告警」：

```yaml
content:
  domain: "AI 科技"        # 你的内容领域，init 只问这一项

platforms:
  bilibili:
    enabled: true
    category_hint: ""      # 分区名，留空 = 不碰分区
  zhihu:
    enabled: true
    field_hint: ""         # 所属领域，留空 = 不填
  wechat:
    enabled: true
    app_id: ""             # 公众号凭证，留空则该通道不可用
    app_secret: ""
```

`init` 会根据你的内容领域给出各平台分区建议值，**但会让你确认或改掉**。
这是「明着猜」和「暗着填」的区别——你能在写进配置前看到它，而不是不知道它存在。

---

## 用法

```bash
# 视频线
node platforms/bilibili.cjs --video a.mp4 --title "标题" --body-file desc.txt \
  --tags "AI,大模型" --cover cover-4x3.png --cover-16x9 cover-16x9.png
node platforms/zhihu.cjs   --video a.mp4 --title "标题" --body-file desc.txt --cover cover-3x4.png
node platforms/weibo.cjs   --video a.mp4 --title "标题" --body-file desc.txt --cover cover-3x4.png
node platforms/shipinhao.cjs --video a.mp4 --title "短标题" --body-file desc.txt --cover cover-3x4.png

# 图文线
node platforms/douyin.cjs open  --kind image
node platforms/douyin.cjs upload --kind image --media ./cards --count 7
node platforms/douyin.cjs fill --kind image --title "标题" --body-file body.txt
node platforms/douyin.cjs collect --kind image      # 合集 + AI 声明（配置为空则跳过并告警）
node platforms/douyin.cjs shot --kind image          # 截图留档，停在发布前

node platforms/weibo-image.cjs --media ./cards --title "标题" --body-file body.txt \
  [--count 7] [--no-declare]   # 微博九宫格；--no-declare 仅本次不声明

node platforms/zhihu-pin.cjs --media ./cards --title "标题" --body-file body.txt \
  [--count 7]                  # 知乎「想法」，无独立标题框，标题并入首行

# 公众号（走官方 API，不经浏览器）
node platforms/wechat.cjs ip        # 查出口 IP，家宽动态 IP 场景需要
node platforms/wechat.cjs check     # 连通性检查（只取 token，无写入）
node platforms/wechat.cjs push --media ./cards --title "标题" --body-file body.txt
```

### 快捷入口

```bash
npx publish-kit doctor    # 等同 node bin/doctor.cjs
npx publish-kit login 抖音 B站
npx publish-kit platforms   # 列出所有脚本与用法
```

---

## 实测耗时

2026-10-21/22 期真实素材实测（8 图 + 视频）。这些数字用来做**长任务优先调度**。

| 平台 | 线 | 耗时 | 备注 |
|---|---|---|---|
| 微博图文 | image | 14s | 8 图 + 10 话题 + 声明 |
| 知乎想法 | image | 27s | 8 图逐张 + 正文 1338 字回读 |
| 抖音图文 | image | 68s | **必须逐张传**（批量多选不可靠）+ 收尾复核张数 |
| 抖音视频 | video | 116s | 上传转码 + 双封面 + 合集 + 声明 |
| 微博视频 | video | 40s | 含内容声明 + 3:4 封面 + 分类频道 |
| 知乎视频 | video | 76s | 含视频标记 + 领域 + 封面 |
| B站视频 | video | 69s | 10 标签 + 双比例封面 + canvas 终验 |
| 视频号 | video | 42s | 含位置/合集/标注 |
| 公众号 | image | ~5s | 走 API，不占浏览器 |
| **9 平台并行** | — | **120.7s 墙钟** | 串行需 613.1s → **5.1×** |

---

## 两条运行通道（架构说明）

目前平台脚本直接用 `patchright`（Playwright 兼容层）连一个外部 Chrome。

这是一个**刻意的选择**：publish-kit 是给「想自己掌控浏览器的人」用的工具 ——
登录态在自己的 profile 里，脚本不碰 profile、不注入指纹、不清 cookie。

其他通道（比如把自动化跑在**受控的独立浏览器**里）也可以接，但它们各有取舍：

| | 外部 Chrome（当前） | 受控独立浏览器 |
|---|---|---|
| 登录态 | 你的日常 profile | 独立空间，隔离更彻底 |
| 依赖 | patchright（MIT） | 往往是闭源商业软件 |
| 开源用户装得上 | ✅ | ❌ 通常要单独买/装 |
| 风控特征 | 真实浏览器特征 | 视实现而定 |

所以本项目的路线是：**核心平台逻辑（选择器、坑位、流程、算法）与运行通道解耦**，
通道做成可替换的实现。已完成的解耦点：

- `lib/wait.cjs` / `lib/log.cjs` / `lib/preflight.cjs` / `lib/ledger.cjs` —— **通道无关**
- `lib/publish-all.cjs` —— 编排层，**通道无关**（它只 spawn 平台脚本）
- 平台脚本里的 DOM 操作 —— 目前与 Playwright 绑定，是**下一步**要解耦的部分

给贡献者的建议：**新加通道时，不要复制 `platforms/*.cjs`**。
先问「这段逻辑是通道无关的平台知识（→ 放 `lib/`），还是通道相关的 DOM 操作（→ 放通道适配层）」。

### 已有的另一条通道（参考实现）

「把整套填单流程搬到另一条受控浏览器上跑」这个需求，已经有人做出来了 ——
在 content 工作区里以 `04_skills/ego-publish/` 的形式存在（独立于本仓库，
因为它还带了内容生产线的编排层）。

它带来的**最大收获不是「多一条通道」，而是把凭手感的地方全变成了可判定的判据**：
那些在原通道上「凑巧能跑」的写法，换条通道就暴露了 —— 假候选、零尺寸按钮、
被破坏的 selection 状态、只信页面文字的计数判据……

本仓库这一轮的内化（`docs/cability-matrix.md` 有完整对照）就是这么来的：
**在一条通道上暴露的问题，修好了对所有通道都成立。**

---

## 两个可能救你时间的技术点

### 大文件上传的 50MB 上限

Playwright / Patchright 的 `setInputFiles` 有一条 50MB 硬上限，报错原文是
`Cannot transfer files larger than 50Mb to a browser not co-located with the server`。
判定依据是「驱动进程与浏览器不同机」，而 `connectOverCDP` 连**本机** Chrome 一律按非同机处理——
所以哪怕浏览器就跑在本机，>50MB 的文件也传不进去。

`lib/bigfile-upload.cjs` 的解法：≤48MB 走原路径，>48MB 改走浏览器原生 CDP
`DOM.setFileInputFiles`——浏览器进程按本地绝对路径自己读盘，不经过驱动传流，无上限，
也不需要把几十 MB 搬进 Node 内存。

shadow DOM 场景（视频号的微前端）还有个坑：CDP 的 `pierce` 参数实测拿不到 nodeId，
得让页面 JS 顺着 `.shadowRoot` 深走拿到 `objectId`。代码里两条通道都实现了。

### 专用 profile 目录

Chrome 136+ 禁止在默认用户数据目录上开 CDP 端口，必须用独立的 `--user-data-dir`。
目录定下就别移动，登录态会一直复用。

---

## 风险提示

本工具通过浏览器自动化操作各平台创作者后台。**部分平台会对使用自动化工具的账号做限制处置**，
这不是理论风险，是真实发生过的。请自行确认你所在平台的服务条款，并自行承担后果。

代码里针对某个平台的每个选择器都附了坑位注释和实测日期——平台改版时请先读注释再改。

各平台的「含 AI 生成内容」声明是平台侧要求。关掉配置里的 `publish.declare_ai`
只是让脚本不代填，发布前仍需你自己勾选，否则可能被平台拦截。

## License

MIT，见 [LICENSE](LICENSE)。使用风险与合规提示见 [NOTICE](NOTICE)。
