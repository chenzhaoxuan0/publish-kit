# AGENTS.md

给 AI agent 的操作说明。**人类用户请读 [README.md](README.md)。**

这个文件假设你正在代替用户操作 publish-kit。以下是流程、决策点和不能碰的红线。

> 📦 **如果你本身就是一个 agent**：仓库里带了一个可直接安装的 skill
> （`skills/publish-kit/`），里面固化了本文的**红线、调用顺序、命令速查、排障路径**。
> 装法见 `skills/publish-kit/INSTALL.md`。本文是**完整版**（更全），skill 是**聚焦版**（更好用）。

---

## 绝对不要做的事

1. **不要跳过 `node bin/init.cjs` 直接跑平台脚本。** 没有 `config.yaml` 时所有平台脚本会
   `FATAL` 退出。若报错提示找不到 config.yaml，先跑 init，**不要**手工造一个 config.yaml。

2. **不要替用户点击「发布 / 发送 / 发表 / 提交投稿」。** 全部脚本的终点就是发布按钮前，
   代码里没有那条路径。如果用户说「帮我发一下」，你只能填单，然后让用户自己点。

3. **不要为了让脚本跑通而修改 `config.yaml` 里的业务字段**（分区、分类、合集、领域）。
   这些值留空是有意设计：脚本会跳过并告警，把决定权交回用户。
   你可以告诉用户「该项未配置，发布前请手动选择」，但不要自己填一个猜的值。

4. **不要在用户的真实已登录浏览器上调试。** 这些脚本连的是用户日常用的 Chrome。
   改选择器时先读脚本文件头的坑位注释，不要靠反复实跑来试探。

5. **不要动 `runtime.profile_dir`。** 那是用户所有平台的登录凭据所在。别复制、别移动、
   别让别的东西读它。

---

## 标准流程

### 首次配置（只在第一次，或用户明确要求重配时）

```bash
node bin/init.cjs
```

交互式问答。用户需要提供：CDP 端口、浏览器 profile 目录、内容领域（AI 科技 / 财经 / 教育 /
其他）、启用哪些平台、各平台分区与合集名、公众号 AppID/AppSecret（可跳过）。

init 结束后立刻：

```bash
node bin/doctor.cjs
```

doctor 会输出：配置是否读到、Node 版本、patchright 是否装好、Chrome 探测结果、CDP 是否在线、
**各平台登录态逐个判定**。任何一项有问题它会给出对应的修复提示，照着做。

### 日常发布

1. `node bin/doctor.cjs --no-launch` 快速确认登录态（不打扰用户当前浏览器会话时用这个）。
   登录态失效 → `node bin/login.cjs <平台名>` 打开登录页，**让用户自己扫码**，然后复核。
2. 填单：

```bash
node platforms/<platform>.cjs --video <mp4> --title "<标题>" --body-file <正文.txt> --cover <封面.png>
```

   视频走 5 个平台脚本；图文走 `douyin.cjs --kind image` / `weibo-image.cjs` / `zhihu-pin.cjs` /
   `wechat.cjs`。每个脚本的文件头有完整用法，**先读文件头再执行**。

3. 脚本每步会截图到 `config.yaml` 的 `publish.screenshot_dir`。**你要看截图确认填单结果**，
   不要只看控制台说「已填」就算完。

4. 停下后告诉用户「已停在发布按钮前，请你点发布」，并附上截图路径。

### 公众号（走官方 API，不经浏览器）

```bash
node platforms/wechat.cjs ip      # 先查出口 IP（家宽动态 IP 会变）
node platforms/wechat.cjs check   # 连通性检查
node platforms/wechat.cjs push --media <目录> --title "..." --body-file <f.txt>
```

终点是**草稿箱**。个人主体账号的发布类 API 权限已被回收，脚本不碰那些接口，
发布必须用户在 mp.weixin.qq.com 后台人工点。报 `invalid ip` 是 IP 白名单没加，不是 bug。

---

## 关键设计约定（改代码前必须理解）

### 留空 ≠ 猜默认值

`lib/config.cjs` 是配置层，核心契约：**没配置就跳过 + 告警，永远不填猜的值。**

理由：这些脚本的终点是「停在发布按钮前」。猜错的分区会静默落到发布页上，用户可能
发布前都没发现。留空时的告警是一次明确提醒，成本远低于发错。

平台自身的硬限制（标题字数、图片张数上限）是另一回事，会保留并在注释里注明来源。

- `cfg.hint(平台, 字段)` → 取字符串值，未配置返回 `''`
- `cfg.bool(平台, 字段)` → 取布尔值。**布尔字段一律用这个**，不能用 `hint()`
  （会把 `false` 转成字符串 `'false'`，真值，把「关」读成「开」）
- `cfg.hintOrFail(...)` → 必填项（如公众号凭证），空值直接抛错并给补法
- `cfg.warnSkipped(...)` → 跳过某字段时的统一告警，自动去重

### 改选择器前先读坑位注释

每个平台脚本文件头和正文里记录了大量实测坑位，例如：

- 微博页面对 `a` 标签入口必须**真实 mouse.click**，`dispatchEvent` 合成 click 会重置整页表单
- 抖音页面上有 5 个 `textContent === '图片'` 的元素，必须按 `getBoundingClientRect()` 面积取最小
- 知乎想法编辑器是 Draft.js `contenteditable`，**必须键盘输入**，直接设 `innerHTML` 不落 React state
- 视频号 wujie 微前端的 DOM 在 `shadowRoot` 里，`body` 恒空是正常架构，**不是**未挂载
- B站上传完成会弹「通知权限」对话框遮挡表单，先点「知道了」

改选择器时**先读对应注释**，不要靠反复实跑试探。

### ⚠️ 调试纪律：先抓地面真相（这一条救过最多的时间）

自动化里出现「**逻辑看着对，但结果恒为空 / 恒失败**」时，**先证明代码在跑的那份和以为在跑的是同一份**，
再谈修法。修法顺序：

1. **写探针脚本，在真机上 dump 地面真相** —— 逐值打印中间量，不要只打印最终结果。
   探针要打的是**判定过程的每一步**：命中了哪个元素、算出了什么值、哪一步返回了空。
2. **探针里 import 真实模块、调真实函数**，与 DOM 快照**同刻对照**。
   读代码 ≠ 代码在跑；`import` 真模块调真函数才是。
3. **每轮改动只改一处**，否则无法归因。

**同一个判定逻辑只保留一个实现。** 本项目栽过：`findSong` 和 `findUseButton`
两个函数逻辑看着一样，真机上 `findSong` 返回按钮、`findUseButton` 恒返回 null，
排查绕了 **8 轮**。两份实现必然漂移 —— 改的时候要一起改，但更好的是**只有一份**。

**别在同一个假设上调参数。** 第一版方向错了以后，继续加轮次/加等待/改超时只会越改越乱。
2026-10-22 抖音话题的教训：第一版假设「联想面板前缀替换」，照这个假设改了两次都失败；
真机探针一打，发现真因是**面板会把你输入的词回显成浏览量 0 的假候选** —— 与原假设无关。

**面板型联想 UI 的「候选存在性」不能只看文本匹配。** 必须找一个「这条候选是真的」的区分特征
（抖音 = 浏览量 > 0；微博 = 面板里有没有这一项）。抖音的话题库里没有某个词时，
面板照样显示「#ZZZ不存在话题 0」—— 只按精确名匹配会把假候选当真，点下去不落 chip。

### 大文件

>48MB 的视频不能直接 `setInputFiles`。所有视频上传统一走
`lib/bigfile-upload.cjs` 的 `setVideoFile()`，它会自动切到浏览器原生 CDP 直传。
微博必须走原生 filechooser 路径，用 `resolveOpenFileChooser()`。
**不要绕开这两个函数。**

---

## 平台与脚本对照

| 线 | 平台 | 脚本 | 关键参数 |
|---|---|---|---|
| 视频 | 抖音 | `douyin.cjs --kind video` | `--cover --vertical/--horizontal` |
| 视频 | B站 | `bilibili.cjs` | `--tags`（不传直接报错，不默认标签）`--cover --cover-16x9` |
| 视频 | 知乎 | `zhihu.cjs` | `--field`、`--cover` |
| 视频 | 微博 | `weibo.cjs` | `--cover`（竖版 3:4）；`cover`/`fill` 为修补模式 |
| 视频 | 视频号 | `shipinhao.cjs` | `--cover`、`--album`、`--location off`；`open` 子命令只开登录页 |
| 图文 | 抖音 | `douyin.cjs --kind image` | `open`/`upload`/`fill`/`collect`/`shot` 五步 |
| 图文 | 微博 | `weibo-image.cjs` | `--media`、`--count`、`--no-declare` |
| 图文 | 知乎想法 | `zhihu-pin.cjs` | `--media`、`--count`；无独立标题框，标题并入首行 |
| 图文 | 公众号 | `wechat.cjs` | `ip`/`check`/`push`；终点草稿箱 |

### 横向能力层（**优先用它，别手写**）

各平台脚本只管「这个平台怎么填」，通用能力在 `lib/`。写新平台脚本时按这个分工：

| 需求 | 用什么 |
|---|---|
| 等某个东西出现 | `lib/wait.cjs` 的 `waitFor(fn, {timeout, interval, step, hint})` |
| 人看的停顿 | `lib/wait.cjs` 的 `humanDelay(min, max, step)`（**不要**拿它当等待条件） |
| 灌长文本 | `lib/wait.cjs` 的 `fillLongText(page, readLength, text)`（自带回读校验 + 自动退回逐块输入） |
| 上传入口点击 | `lib/wait.cjs` 的 `pickFileWithRetry(page, locateEntry)`（最多重试 3 次，每次重新取坐标） |
| 记录耗时与告警 | `lib/log.cjs` 的 `create({platform, kind})` → `log.step() / log.warn() / log.finish()` |
| 起浏览器前体检 | `lib/preflight.cjs` 的 `preflight({...})`（图集张数 / 正文长度 / 违禁 / 标题） |
| 防重复发布 | `lib/ledger.cjs`（**可选**，配了 `publish.ledger` 才启用） |
| 多平台并行 | `bin/publish-all.cjs`（不要自己写调度） |

⚠️ **不要绕过 `lib/bigfile-upload.cjs`**：>48MB 的视频必须走它的 `setVideoFile()`，
微博必须走 `resolveOpenFileChooser()`。

⚠️ **preflight 抛错时不要 catch 后继续** —— 契约是「体检不过就不起浏览器」。

⚠️ **登录态判据暂时没收敛** —— `lib/platforms.cjs` 有张统一表，但 6 个平台脚本各自保留着
自己的就地判据（有的判 URL 跳 `passport`、有的判页面上某个按钮在不在）。
这是**有意为之**：各平台的判据确实不同（知乎判「发想法」按钮、视频号判壳首页），
而判据都紧跟在导航之后，就地判定最可靠。**不要为了「统一」去动它** ——
统一判据的改动风险大于收益。真要动，逐个平台核对过再改。

### 自检

改完 `lib/` 下的模块后跑：

```bash
node selftest.cjs      # 33 项，覆盖等待/日志/体检/台账/编排
```

平台脚本的改动至少跑一次 `node --check platforms/<file>.cjs`。

---

## 出问题时

| 现象 | 多半是 |
|---|---|
| `FATAL 找不到 config.yaml` | 没跑 init。跑 `node bin/init.cjs` |
| `连不上 CDP` | Chrome 没起。跑 `node bin/doctor.cjs`（不加 `--no-launch` 会自动拉起） |
| `端口被占用/拒绝访问` | 端口落在 Windows 保留段。`netsh interface ipv4 show excludedportrange protocol=tcp` 查一下，换 `runtime.cdp_url` |
| `未登录` | 让用户扫码。`node bin/login.cjs <平台>`，**不要试图自动登录** |
| `某平台未登录/字段未配置` | 正常。脚本会跳过并告警，转人工处理，**不要自己编一个值填上** |
| 选中的元素点不动 | 很可能需要真实 mouse.click 而非合成 click，读该平台的坑位注释 |
| 视频传不进去（>50MB） | 确认走的是 `setVideoFile()`，不要自己写 `setInputFiles` |
| 判定恒为空 / 恒失败 | **先写探针抓地面真相**，别在同一个假设上调参数（见上面「调试纪律」） |
| 图集体检说「缺 01, 02」但文件明明在 | 命名约定：`img-01.png` / `01.png` / `card_34_01.png` 都认；改 `lib/preflight.cjs` 的 `listImages` 时注意 |

改完任何平台脚本后，至少跑一次 `node --check platforms/<file>.cjs`。
改完 `lib/` 下任何模块后，跑一次 `node selftest.cjs`。
