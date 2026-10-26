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

   **多个平台、且各平台物料不同时 → 用发布清单**（见下节）：
   ```bash
   node bin/publish-manifest.cjs <清单.yaml> [--dry-run] [--check-only]
   ```

3. 脚本每步会截图到 `config.yaml` 的 `publish.screenshot_dir`。**你要看截图确认填单结果**，
   不要只看控制台说「已填」就算完。

   ⚠️ **截图失败不影响成败判据** —— 判据全在 DOM，截图只是留档。
   看到「⚠ 截图失败（已忽略，不影响填单结果）」**不要**当成发布失败重跑。

4. 停下后告诉用户「已停在发布按钮前，请你点发布」，并附上截图路径。

### 发布清单（多平台 / 多形态 / 多内容类型）

当「一次要发多个平台」且**各平台的物料不一样**时，用清单而不是扁平 CLI 参数：

```bash
node bin/publish-manifest.cjs <清单.yaml> --dry-run     # 先看要跑什么
node bin/publish-manifest.cjs <清单.yaml> --check-only  # 只体检
node bin/publish-manifest.cjs <清单.yaml>               # 真填单
```

清单长什么样见 `docs/manifest.example.yaml`。要点：

- **每个槽位有自己的物料**：`title` / `titleFile`（平台专属标题变体）/ `bodyFile` /
  `media` + `count` / `video` / `cover` / `covers[]` / `tags`
- **平台专属开关进 `options:`**（抖音 `album`/`music`、微博 `channel`/`sub`、
  知乎 `field`、视频号 `album`/`location`）——写表外的开关**直接报错**，不会静默丢
- **`via`** 表达运行通道：`browser` / `api` / `manual`
- **`via: manual` 的槽位不会执行任何自动化**，只在结果里提醒你人工去发
  （零自动化是账号级决策，工具不替你破例）

⚠️ **体检不过就不起浏览器** —— 清单的校验（物料缺失 / 图集不足 / 标题超限 / 未知开关）
全是秒级的本地检查，失败会直接中止。

### 失败之后

编排层会自动诊断并给出**可执行**建议（`lib/diagnose.cjs`）。按建议走，不要盲目重跑：

| 级别 | 你的动作 |
|---|---|
| `channel-dead` 通道不可用 | **别再填单**。跑 `node bin/doctor.cjs` 看 CDP 是否在线；平台可能改版了 → 读该平台脚本文件头的坑位注释 |
| `login-required` 登录态失效 | `node bin/login.cjs <平台>` 让用户扫码。**不要自动重试** |
| `content-rejected` 素材被拒 | 改物料（缺什么补什么）。**重试无意义** |
| `cosmetic` 仅截图失败 | 填单其实已经成了，通常不用管 |
| `retryable` 偶发失败 | 编排层已自动重试过一次；仍失败 → 按 channel-dead 处理 |

⚠️ **自动重试有边界**（别绕过它）：只重跑**失败的那一步**，且该步必须幂等
（重新上传素材那一步不幂等 → 不重跑）；**API 通道（公众号永久素材）永不自动重跑**。


### 公众号（走官方 API，不经浏览器）

```bash
node platforms/wechat.cjs ip      # 先查出口 IP（家宽动态 IP 会变）
node platforms/wechat.cjs check   # 连通性检查
node platforms/wechat.cjs push --media <目录> --title "..." --body-file <f.txt>
```

终点是**草稿箱**。个人主体账号的发布类 API 权限已被回收，脚本不碰那些接口，
发布必须用户在 mp.weixin.qq.com 后台人工点。报 `invalid ip` 是 IP 白名单没加，不是 bug。

### ego lite 通道（config.yaml `runtime.driver: "ego"`）

同一份平台知识可跑在 ego lite 上（并行发布比单实例 CDP Chrome 快数倍）。
通道差异全部收在 `lib/driver.cjs`（工厂）+ `lib/drivers/ego.cjs`（Playwright 形状门面），
平台脚本一份代码两通道通用 —— **不要在平台脚本里写通道分支**。

操作差异（对照上面的 playwright 流程）：

| 环节 | playwright | ego |
|---|---|---|
| 启动 | `node platforms/douyin.cjs …` | 同一条命令，但 `driver: ego` 时**编排器自动**改经 `pwsh -NoProfile -File bin/ego-run.ps1 -Script platforms/<脚本> -ScriptArgs <json>` 启动；手工单跑也要走 ego-run.ps1（ego 运行时收不到 argv） |
| 体检 | `node bin/doctor.cjs`（CDP/Chrome/profile） | 同一条命令，自动切成 ego 体检（找 ego-browser + 空间前缀） |
| 登录 | `node bin/login.cjs <平台>` 开登录页 | **在 ego lite 窗口里登录**（登录态在 ego profile，所有 TaskSpace 共享） |
| 并行 | 一个 Chrome 多标签页 | 每平台独立 TaskSpace，空间名 `pk-<平台>-<线>-<spaceKey>`（前缀 `runtime.space_prefix`，默认 `pk`，**与 operation 的 op 隔离**） |

ego 通道的硬约束（脚本与编排器已内置，不要绕）：

- **绝不调 `task.finish()`**（会关掉表单页）；交还用户只能经编排器注入的
  `--handoff 1`（**只在序列最后一条命令**；中间命令交还 = 后续命令接管撞墙，ego hard stop）。
- **绝不自动 `claimTaskSpace`**（需要用户批准）。空间救不活 → 门面自动换 `-r2/-r3` 新空间名。
- `page.url()`/`ctx.pages()` 在两通道都按 `await` 写（playwright 同步值被 await 是无操作）。
- evaluate 一律「无闭包捕获、至多一个参数」形状（ego 的硬约束；playwright 兼容）。
- **>48MB 大文件不走 ego**（filechooser 大文件路径未实测）→ 脚本报错转人工，改 playwright 或人工接管。
- 截图失败、`waitForSelector visible` 不可信等 ego 坑位已在门面里处理；判据永远在 DOM。

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
| 截图留档 | `lib/shot.cjs` 的 `shot(page, path)`（**永不抛异常**，失败只告警） |
| 记录耗时与告警 | `lib/log.cjs` 的 `create({platform, kind})` → `log.step() / log.warn() / log.finish()` |
| 起浏览器前体检 | `lib/preflight.cjs` 的 `preflight({...})`（图集张数 / 正文长度 / 违禁 / 标题） |
| 防重复发布 | `lib/ledger.cjs`（**可选**，配了 `publish.ledger` 才启用） |
| 多平台并行 | `bin/publish-all.cjs`（不要自己写调度） |
| **多平台各自物料** | `lib/manifest.cjs` + `bin/publish-manifest.cjs`（**不要**自己拼参数） |
| **平台信息（形态/脚本/耗时/限制）** | `lib/platforms.cjs`（**平台注册表，唯一事实源** —— 不要另抄一份） |
| **失败诊断** | `lib/diagnose.cjs` 的 `diagnose({code, stdout})` |
| **链接该属于哪个平台** | `lib/platform-urls.cjs` 的 `urlMatchesPlatform(url, platform)` |

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
node selftest.cjs      # 104 项，覆盖等待/日志/体检/台账/编排/清单/诊断/截图/链接闸
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
| 图集体检说「序号断了」 | 目录里的序号不连续（01,02,04）→ **顺序会错位**。确认是「漏生成」还是「命名跳号」，补齐再发 |
| 清单体检说「不认识开关 options.X」 | 该平台没有这个开关。查 `lib/manifest.cjs` 的 `OPTION_FLAGS` / `STEP_OPTIONS` / `VALUE_LESS_OPTIONS`；**不要**为了绕过它去改脚本 |
| 清单体检说「不认识平台 X」 | 若该平台走**零自动化**，显式写 `via: manual`（只备料）；否则本工具确实不支持它 |
| 抖音只开了页、没填单 | 抖音是多命令模型（open→upload→fill→…→shot）。**必须走清单模式或 `bin/publish-all.cjs`**，不要自己拼单条 `douyin.cjs` 命令 |
| 截图失败 | **不是发布失败**。判据全在 DOM，截图只是留档。看控制台那行「⚠ 截图失败（已忽略）」即可 |
| 公众号 `check` 退出码异常 / 崩溃 | 已修（Windows libuv 断言）。仍异常 → 查凭证与 IP 白名单 |

改完任何平台脚本后，至少跑一次 `node --check platforms/<file>.cjs`。
改完 `lib/` 下任何模块后，跑一次 `node selftest.cjs`。
