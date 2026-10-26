# publish-kit 能力矩阵与迭代路线

> 这份文档记录**每一项能力从哪来、现在什么状态、还缺什么**。
> 目的：让后续迭代有据可依，而不是每次都从头摸索。
>
> **最后更新：2026-10-26**

---

## 一、来源：2026-10-21/22 那轮实战

publish-kit 的能力演进，一直靠**真实平台上反复验证**推进。最近一轮密集迭代发生在
「把同一套填单流程搬到另一条运行通道（ego lite 浏览器）」的过程中 ——
那条通道要求把「凭手感」的地方全部改成**可判定的判据**，于是暴露出一批原本靠运气的问题。

这一轮挖出来并修好的问题（**全部已内化回本仓库**）：

### 平台知识类

| # | 问题 | 根因 | 现在怎么做 |
|---|---|---|---|
| 1 | 抖音话题尾部变成字符交织的乱码 | ① 联想面板**永远把输入的词回显成浏览量 0 的假候选**；② `selectAllChildren`+`collapseToEnd` 挪光标会**破坏编辑器 selection 状态**；③ 面板**两段式渲染**（先回显、后远程列表，且边打字边过滤） | 判据改为「精确名 **且 浏览量 > 0**」；光标改用 `Control+End`；等**连续两轮读到相同候选列表**才判定。详见 `platforms/douyin.cjs` 的坑位注释 |
| 2 | 抖音配乐（收藏配乐 Opus 37）一直是人工操作 | 入口文案出现两次（行标题 + 动作按钮）、面板是**抽屉不是 modal**、「使用」按钮**未 hover 时零尺寸**、乱滚会把曲名推出视口、失败时抽屉不关会挡住合集下拉 | 新增 `music` 子命令 + `lib/` 里的通道无关实现。见下方「新增模块」 |
| 3 | 抖音封面模式判据会**整条视频线 FATAL 中止** | 判据是「编辑器标题文本」；**「没步骤条」被当成错误**——但那其实是「单模式直传面板」，模式由所点槽位决定，本来就对 | 改读步骤条的 `step-active`；**没步骤条 = 告警后继续**，不 FATAL |
| 4 | 抖音图文**完全不数图片** | 传完只 `waitForTimeout(15000)`；而「已添加 N 张」这个文字计数统计的是**上传队列**，不是实际渲染数 | 逐张传（批量多选不可靠）+ 数**实际渲染的缩略图**（限定在图集区） |
| 5 | 抖音图文**批量多选会掉图** | 同一份代码连测 8 次，结果在 6/6、1/6、0/6 之间跳 | 逐张传，每张等落位 |
| 6 | B站上传完成弹**浏览器级通知权限**硬停 | 没预授权 | `grantPermissions(['notifications'], {origin})` 预授权 |
| 7 | 视频号直接塞 `input[type=file]` **文件不落表单** | 视频号是 Ant Design 拖拽区，input 是隐藏的 | 按 input 的**可见祖先**定位并点击 |
| 8 | 「声明要传几张」与「目录里真有几张」**从不比对** | 只查「声明的 N 个文件都在」，多余文件静默忽略；且检查排在起浏览器**之后** | `lib/preflight.cjs`：**起浏览器之前**核对，不过就不执行 |

### 工程化类

| # | 能力 | 说明 |
|---|---|---|
| 9 | 长文本一次性插入 | 逐字 type = N 次 CDP 往返。实测 958 字：12s → 0.6s，**省约 11s**。必须带**回读校验 + 自动退回逐块输入** |
| 10 | 并行编排 | 串行 613.1s → 并行 120.7s 墙钟（**5.1×**）。两条规则：**长任务优先调度** + **默认并发上限 5**（9 全并发会触发平台侧限流，降到 5 反而更快） |
| 11 | 条件等待 + 随机节奏 | 固定等待等不够就往下走、等太久就是白等。185 处固定等待统一成两种语义明确的原语 |
| 12 | 每平台独立日志 | 带时间戳每一步 + 收尾**步骤耗时倒序表** + 告警汇总。慢在哪不该靠猜 |
| 13 | 起浏览器前体检 | 「上传后确认成功」的判据只能证明**页面上的东西**，证明不了**喂进去的东西** |
| 14 | 可选防重复发布台账 | 页面态护栏挡不住「昨天发过」「已交割还没点」「失败重跑」 |
| 15 | 上传入口重试 | 点击后**偶发**唤不起文件选择器（坐标与成功那轮完全一致）。微博/抖音图文/抖音视频三个平台都踩过 → 最多重试 3 次，每次重新取坐标 |

---

## 二、当前能力矩阵

| 能力 | 状态 | 位置 |
|---|---|---|
| 条件等待 / 随机节奏 | ✅ | `lib/wait.cjs` |
| 长文本一次性插入（带回读+退回） | ✅ | `lib/wait.cjs` `fillLongText()` |
| 上传入口重试 | ✅ | `lib/wait.cjs` `pickFileWithRetry()` |
| 每平台日志 + 耗时表 | ✅ | `lib/log.cjs` |
| 起浏览器前体检 | ✅ | `lib/preflight.cjs` |
| 并行编排（长任务优先 + 并发上限） | ✅ | `lib/publish-all.cjs` + `bin/publish-all.cjs` |
| 可选防重复台账 | ✅ | `lib/ledger.cjs` |
| 抖音话题单轮法 | ✅ | `platforms/douyin.cjs` |
| 抖音配乐 | ✅ | `platforms/douyin.cjs` `music` 子命令 |
| 抖音封面模式判据 | ✅ | `platforms/douyin.cjs` |
| 抖音图文图片计数 | ✅ | `platforms/douyin.cjs` |
| B站通知权限预授权 | ✅ | `platforms/bilibili.cjs` |
| 视频号可见祖先定位 | ✅ | `platforms/shipinhao.cjs` |
| 大文件上传（>48MB 走 CDP 原生直传） | ✅ | `lib/bigfile-upload.cjs` |
| 公众号 API 推草稿箱 | ✅ | `platforms/wechat.cjs` |
| **平台中立发布清单（manifest）** | ✅ **2026-10-26 新增** | `lib/manifest.cjs` + `bin/publish-manifest.cjs` |
| **每平台各自物料 + 标题变体** | ✅ **2026-10-26 新增** | `lib/manifest.cjs`（`titleFile` / `covers[]` / `options`） |
| **失败自动诊断（分级）** | ✅ **2026-10-26 新增** | `lib/diagnose.cjs` |
| **截图降级为告警（不参与成败判据）** | ✅ **2026-10-26 新增** | `lib/shot.cjs` |
| **浏览器平台自动重试 1 次（API 豁免）** | ✅ **2026-10-26 新增** | `lib/publish-all.cjs` `runSlot()` |
| **平台注册表合一处** | ✅ **2026-10-26 新增** | `lib/platforms.cjs`（清单/登录/耗时/限制同源） |
| **平台↔链接域名闸 + 匿名核验** | ✅ **2026-10-26 新增** | `lib/platform-urls.cjs` |
| **图集断号检查（顺序错位）** | ✅ **2026-10-26 新增** | `lib/preflight.cjs` |
| **多运行通道（driver 抽象）** | ❌ **未做** | 见下方路线 |
| 平台脚本的 DOM 操作与通道解耦 | ❌ 未做 | 见下方路线 |
| 统一的登录态判据 | ⚠️ 有意不做 | `lib/platforms.cjs` 注释里说明了原因 |

---

## 三、2026-10-26 这一轮：从「一份物料」到「发布清单」

### 为什么做这一轮

两个真实工作区（`content` 的每日新闻线、`operation` 的审美卡片线）各自跑着成熟的发布实践，
两边**各写各的**。把两边的现行实践搬进本仓库时，暴露了本仓库最大的结构缺口：

**本仓库的编排接口是「一份物料打所有平台」**：

```bash
node bin/publish-all.cjs --media ./cards --count 8 --title "标题" --body-file body.txt \
     --platforms douyin,weibo,zhihu
```

这套扁平参数回答不了真实发布的三个问题：

1. **每个平台的正文不一样**（抖音 600 字简介 / 公众号 1200 字正文 / 知乎想法标题并进首行）
2. **每个平台的标题不一样**（视频号 ≤16 字，必须**另起一版**，截主标题会截出半句话）
3. **每个平台的物料组合不一样**（B站要 4:3 + 16:9，抖音要竖封面 + 横封面）

### 挖出来并修好的问题

| # | 问题 | 根因 | 现在怎么做 |
|---|---|---|---|
| 1 | **抖音只开页、没填单，却报成功** | `douyin.cjs` 是**多命令模型**（open→upload→fill→music/collect→cover→shot），而旧编排器给它拼了一条**不带子命令**的命令 → 脚本默认 `cmd='open'` → 只导航到上传页就退出了 | 命令序列统一由 `lib/manifest.cjs` 的 `planCommands()` 生成；编排层只管按序执行。**抖音视频线同理**：旧代码传 `--video`，而该脚本读的是 `--file` |
| 2 | **平台不支持该形态时会「假成功」** | 旧 `buildCommand()` 对 B站/视频号的图文线照样拼出一条命令，跑完 0 步、退出码 0 | 无命令序列的槽位**显式判失败**并说清楚原因；`bin/publish-all.cjs` 的自检用例同步改成按形态断言 |
| 3 | **截图失败会杀掉整轮发布** | 平台脚本收尾裸调 `page.screenshot()`，Playwright 默认超时 30s。实测：三个平台的图都传完了，只因一次 `Page.captureScreenshot` 超时，整轮白跑 | 新增 `lib/shot.cjs`：自带 6s 短路超时、**永不抛异常**，失败只告警。判据全在 DOM，截图是旁路 |
| 4 | **失败后不知道该干什么** | 只有退出码和一个 stack | 新增 `lib/diagnose.cjs`：把失败分成 6 级，每级给一条**可执行**建议 |
| 5 | **重试没有判据** | 「失败就重跑」会把永久素材（公众号）重传一遍 → 白占素材库配额 | 自动重试只重跑**失败的那一步**，且该步必须幂等；**API 通道永不自动重跑** |
| 6 | **平台信息散在 4 个地方** | 登录判据、脚本映射、实测耗时、标题上限各在一处 → 漏改一处就静默失效 | `lib/platforms.cjs` 改成**平台注册表**（唯一事实源），清单/编排/体检都从它派生 |

### 失败诊断的 6 级分级（本轮最有价值的抽象）

| 级别 | 含义 | 允许自动重试？ | 处置 |
|---|---|---|---|
| `channel-dead` | 通道整体不可用（导航 / 执行上下文 / CDP） | ❌ | **别再填单**，先修通道 |
| `login-required` | 登录态失效 / 公众号凭证与 IP 白名单 | ❌ | 让用户扫码 |
| `content-rejected` | 素材或文案被平台拒 | ❌ | 改物料，重试无意义 |
| `cosmetic` | **只是截图失败** | ✅（且代价低） | 填单其实已经成了 |
| `retryable` | 偶发失败（超时 / 点击没生效） | ✅ | 重跑一次 |
| `unknown` | 认不出来 | ❌ | 给人看，不自动重试 |

> ⚠️ **「截图失败」曾经把整轮发布判死** —— 这是这一轮分级存在的直接原因。
> **「退出码 1 就归因成内容问题」是不对的**：必须**有明确的报错标记**才这么判，
> 否则会把「看不懂的失败」误导成「改文案就行」。

### 发布清单（manifest）模型

清单 = 「这条内容要发到哪些平台、每个平台填什么」的**数据**。体检、编排、留痕读**同一份**。

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
  video:
    slots:
      - platform: shipinhao
        kind: video
        titleFile: "manuscript/sph-title.txt"   # 平台专属标题变体（另起一版）
        video: "video/release.mp4"
        covers: ["covers/cover-3x4.png"]
```

四条设计约定：

1. **路径相对清单文件所在目录**（不相对工作区根）—— 清单要能随内容目录搬家
2. **`via` 表达运行通道**（`browser` / `api` / `manual`），**不用 `channel`** ——
   `channel` 在微博语境里是「一级频道」，两个含义撞在一起会让清单读起来像 bug
3. **平台专属开关进 `options:`**，不进顶层字段；写表外的开关**直接报错**，不静默丢
4. **未知平台必须显式写 `via: manual`** —— 漏声明会被拦下来，
   免得把「零自动化」变成「忘了配」

### 收录边界（这一轮的纪律）

从两个工作区搬东西进来时，按同一条线切：

| 进 publish-kit（通用能力） | 留在工作区（特有约定） |
|---|---|
| 平台填单知识与判据 | 台账**格式**（publish.yaml / operation 的 publish.yaml） |
| 发布清单**模型**（形状） | 清单里的**具体路径**（`manuscript/dy-body.txt` 等） |
| 失败诊断分级 | 日更流水线骨架（找 ready 期、上游交付门禁） |
| 截图降级、等待原语、编排、并发口径 | link-hub 页面与其 HTTP 端点、留痕文件结构 |
| 平台↔链接域名闸、匿名核验 | 飞书通知、运营总览视图生成 |
| 平台注册表（清单/登录/耗时/限制同源） | 账号 id 表、CDP 端口与 profile 路径 |
| 图集断号检查等**物料体检判据** | workflow yaml（各工作区自己的流水线节奏） |

> ⚠️ **小红书「零自动化」是账号级决策，不是通用禁令** ——
> 进本仓库的应该是**机制**（`via: manual` + `assertAutoAllowed()`），
> 不是这个具体平台的禁令。

---

## 四、路线图：多运行通道

### 为什么需要

现在的平台脚本直接用 `patchright` 的 page API。这是**刻意的**：publish-kit 是给
「想自己掌控浏览器的人」用的 —— 登录态在自己的 profile 里，脚本不碰 profile、
不注入指纹、不清 cookie。

但别的通道各有优势：受控的独立浏览器隔离更彻底、可以并行不互相干扰。
问题是那些通道往往是**闭源商业软件**，开源用户装不上。

### 已完成的解耦

- `lib/wait.cjs` / `lib/log.cjs` / `lib/preflight.cjs` / `lib/ledger.cjs` —— **通道无关**
- `lib/publish-all.cjs` —— 编排层，**通道无关**（它只 spawn 平台脚本）
- `lib/config.cjs` —— **通道无关**

### 未解耦的部分

`platforms/*.cjs` 里的 DOM 操作直接绑定 Playwright 的 `locator` / `waitForEvent` / `evaluate`。

### 建议的推进方式（**不要一次性全改**）

1. **先抽一个平台的 DOM 操作到 `lib/drivers/<channel>/`**，作为**示范**，
   证明「同一份平台知识能跑在两条通道上」。
   选抖音（坑位最多、验证最充分）。
2. 示范跑通后，**其余平台逐个迁移**，每个平台迁移完跑一次真机验证。
3. 配置层加 `runtime.driver: playwright | <channel>`，默认 `playwright`，
   **开源用户零影响**。

> ✅ **2026-10-27 阶段 1 落地（架构层 + 抖音示范，真机验证待做）**：
> - `lib/driver.cjs` —— 通道工厂。通道判定：环境事实优先（`globalThis.__OP_ARGS__` 只可能由
>   `bin/ego-run.ps1` 的 wrapper 注入），`runtime.driver` 是意图声明（声明 ego 却在普通
>   node 里跑 → 明确报错，不静默回落）。patchright **惰性加载**（ego 运行时绝不 import 它）。
> - `lib/drivers/ego.cjs` —— ego 门面，**回灌自 operation/04_skills/ego-publish/lib/runtime.mjs**
>   （死页自愈 openSpaceAuto/getPage、截图竞速、filechooser 重试、fillGuard、fillEditor 等
>   2026-10-22~24 真机验证过的实现）。对外暴露 Playwright 形状的 page/ctx：
>   `url()` 异步化、`waitForEvent('filechooser')→waitForFileChooser`、`screenshot` 剥 timeout、
>   `$()` 句柄走坐标点击避开多命中歧义、`locator().nth().screenshot()` 走 clip、
>   和弦键位归一、多命中自动 `>> nth=0`。
> - 编排器：`driver: ego` 时浏览器槽位自动改经 `bin/ego-run.ps1`（ScriptArgs 注入），
>   每命令带 `--space-key`（同一内容多命令共享 TaskSpace），**最后一条命令**注入 `--handoff 1`
>   （中间命令交还 = 后续命令接管撞墙），stdout 抓 `spaceId` 进槽位结果与台账 note。
> - 抖音示范：bootstrap 换 driver 工厂、`page.url()`/`ctx.pages()` 异步化、`--force` 三形态归一；
>   顺手修了存量 bug（`sleep()` 在 upload/cover 路径被裸调但从未定义 → ReferenceError）。
> - 门面纯逻辑进 selftest（132 项全绿：死页自愈换名、接管被拒原样抛、截图剥 timeout 等）。
> - **真机验证（2026-10-27 凌晨，aesthetic/2026-10-20_bento-grids 欠账补发实测）**：
>   全链路 6 步（open→upload→fill→music→collect→shot+handoff）在 ego 通道跑通，
>   表单 6/6 图 + 标题/正文/4 话题 chip + 合集「审美积累」+ 自主声明全部落位，停在发布按钮前。
>   实测抓出并当场修掉 3 个通道缺陷：
>   ① **spawn stdin 挂死** —— node spawn pwsh 默认 stdin pipe 时 ego-browser CLI 启动即僵死
>     （CPU 0），`stdio: ['ignore','pipe','pipe']`（对齐 operation）解决；
>   ② **可选项转发陷阱** —— ego 对显式 undefined 实参敏感（`evaluate(fn, undefined)` 报
>     "must be JSON-serializable"），门面全部可选项改经 `fwd()`（剥尾部 undefined）转发；
>   ③ **上传入口文案** —— 第 1 张传完后抖音上传区进入「继续添加」态，原 file input 消失，
>     回退路径只认「点击上传…图片」导致 1/6 残缺图集；locateEntry 补「继续添加」匹配后 2/2 ✓。
>   **已知遗留（fail-soft，不阻塞）**：配乐步紧跟 fill 之后偶发静默早退（单独跑/collect 后跑
>   都稳定成功；失败时只 warn 不阻塞，人工补选 10 秒）；upload 偶发 5/6（复核判据 warn 级，
>   截图目检兜底）。两项待下轮专项加固。
>   另：ego lite 的 handOff 红线实测有效 —— 交还后的空间再碰即 hard stop，编排器按
>   空间名变体（-r2/-r3）自愈开新空间，不接管用户空间。

### 给贡献者的一条硬规矩

**新加通道时，不要复制 `platforms/*.cjs`。**
先问自己：「这段逻辑是**通道无关的平台知识**（→ 放 `lib/`），
还是**通道相关的 DOM 操作**（→ 放通道适配层）？」

判断标准：换一条通道，这段代码**需要改**吗？需要 → 通道相关；不需要 → 通道无关。

---

## 五、调试纪律（这一条救过最多的时间）

自动化里出现「**逻辑看着对，但结果恒为空 / 恒失败**」时，
**先证明代码在跑的那份和以为在跑的是同一份**，再谈修法。

1. 写探针脚本在真机上 dump **地面真相**（逐值打印中间量，不要只打印最终结果）
2. 探针里 **import 真实模块、调真实函数**，与 DOM 快照**同刻对照**
3. 每轮改动**只改一处**，否则无法归因

**同一个判定逻辑只保留一个实现。** 本项目栽过：`findSong` 和 `findUseButton`
逻辑看着一样，真机上 `findSong` 返回按钮、`findUseButton` 恒返回 null，排查绕了 8 轮。

**别在同一个假设上调参数。** 抖音话题第一版假设「面板前缀替换」，
照这个假设改了两次都失败；真机探针一打，真因是「面板回显假候选」——与原假设无关。

---

## 六、与 content 工作区的关系

`publish-kit` 是**通用工具**，本仓库（content）是一个**具体的内容生产线**。
两者共享平台知识，但用途不同：

| | publish-kit（本仓库） | content 工作区 |
|---|---|---|
| 定位 | 开源通用填单工具集 | 自媒体内容生产线（选题→卡片→视频→多平台发布→复盘） |
| 通道 | Playwright + CDP 连外部 Chrome | 有两条：Playwright（publish-kit）+ ego lite 独立浏览器 |
| 台账 | `publish.ledger`（**可选**） | `01_projects/<期>/publish.yaml`（L1 唯一事实源，必需） |
| 编排 | `bin/publish-all.cjs`（通用并行） | workflow yaml 驱动的多步骤流水线 |

**知识流向**：在 content 工作区实测出来的东西（平台改版、新坑、更好的判据），
应该**回灌**到本仓库 —— 本文件第一节列的就是这样一批。
反过来，本仓库的横向能力层（等待/日志/体检/台账/编排）也可以被 content 复用。

**纪律**：
- 平台知识（选择器、坑位、判据）→ 回灌本仓库，**且要带实测依据**（口径数字要标明来源）
- content 工作区的**项目特有约定**（台账格式、workflow、素材目录）→ **不要**搬进本仓库
- 硬闸（会阻塞的判据）必须有实测依据；没有依据的口径用**软线**（只告警）
- ⚠️ **两边是独立仓库，代码不能共享 —— 所以平台知识会漂移。**
  改了一边的平台逻辑，**另一边要同步**：本仓库是**开源主仓**（面向所有用户），
  content 工作区是**重度使用方**。以本仓库为准，回灌到 content 侧。
  同步清单见下面第七节。

---

## 七、这一轮内化的同步清单

publish-kit（Playwright）与 content 工作区（ego lite）是**独立仓库，代码不能共享**。
这一轮两边都改了，**同步状态如下**：

| 能力 | publish-kit | content/ego-publish | 一致？ |
|---|---|---|---|
| 抖音话题单轮法 | ✅ `platforms/douyin.cjs` | ✅ `lib/douyin-topics.mjs` | ✅ |
| **知乎想法编辑器入口** | ✅ `platforms/zhihu-pin.cjs`（2026-10-26 重写：点「发想法」BUTTON + placeholder 兜底 + 最多重试 3 次） | ✅ `platforms/zhihu.mjs`（2026-10-20 定位、10-22 补重试） | ✅ **2026-10-26 补同步**（此前 ego 侧早已注明本仓库这条路子失效，本仓库未同步 → B 通道在当前 UI 上恒 0 宽 FATAL） |
| **知乎传图策略** | ✅ **一张一张插**（每张独立走三层 UI + 「图集区计数必须 +1」判据 + 3 次重试） | ✅ 一次传 N 张 + blob≥N×2 判据（2026-10-26 修计数滞后） | ⚠️ **实现不同、行为等价**（本仓库逐张插没有「批量点选被裁切」与「计数滞后」两个坑） |
| 抖音配乐 | ✅ `douyin.cjs music` 子命令 | ✅ `lib/douyin-music.mjs` | ✅ |
| 抖音封面模式判据（step-active） | ✅ | ✅ | ✅ |
| 抖音图文逐张传 + 数实际缩略图 | ✅ | ✅ | ✅ |
| 微博九宫格计数 v4（限定 composer） | ✅ | ✅ | ✅ |
| B站通知权限预授权 | ✅ | ✅ | ✅ |
| 视频号可见祖先定位 | ✅ | ✅ | ✅ |
| 条件等待 / 随机节奏 | ✅ `lib/wait.cjs` | ✅ `lib/runtime.mjs` | ⚠️ 语义一致、代码各一份 |
| 长文本一次性插入 | ✅ `lib/wait.cjs` | ✅（抖音脚本内联） | ⚠️ |
| 起浏览器前体检 | ✅ `lib/preflight.cjs` | ✅ `lib/preflight.mjs` | ⚠️ |
| 并行编排 | ✅ `lib/publish-all.cjs` | ✅ `tools/publish-all.mjs` | ⚠️ |
| 防重复台账 | ✅ `lib/ledger.cjs`（可选） | ✅ `lib/ledger.mjs`（必需） | ⚠️ 语义不同（见下） |
| **发布清单（manifest）** | ✅ `lib/manifest.cjs` + `bin/publish-manifest.cjs`（2026-10-26 新增） | ✅ `lib/plan.mjs`（形状同源，路径是 content 特有） | ⚠️ **形状已对齐，载体不同** —— content 侧是硬编码 JS 常量，本仓库是 YAML 数据文件（**多内容类型兼容的关键**）。⚠️ **content 侧待回灌**：把 `plan.mjs` 的路径迁成本仓库的清单文件 |
| **抖音命令序列** | ✅ `lib/manifest.cjs` `planCommands()`（open→upload→fill→music/collect→cover→shot） | ✅ ego 侧是单进程内多步 | ⚠️ **语义一致、实现不同**：本仓库是「一个平台脚本 + 多个子命令」，ego 侧是一个脚本内部走完。⚠️ 本仓库侧 **2026-10-26 修掉了「只开页不填单却报成功」的 bug** |
| **失败自动诊断分级** | ✅ `lib/diagnose.cjs`（2026-10-26 新增） | ❌ 无 | ⚠️ **本仓库领先** → 应回灌到 content 侧编排层 |
| **截图降级为告警** | ✅ `lib/shot.cjs`（2026-10-26 新增） | ✅ `lib/runtime.mjs`（operation 版 2026-10-24 起） | ✅ 语义一致、代码各一份 |
| **浏览器平台自动重试 1 次（API 豁免）** | ✅ `lib/publish-all.cjs`（2026-10-26 新增） | ✅ operation 版编排层 | ✅ 语义一致、代码各一份 |
| **平台↔链接域名闸 + 匿名核验** | ✅ `lib/platform-urls.cjs`（2026-10-26 新增） | ✅ `04_skills/lib/link-backfill.mjs`（`urlMatchesPlatform`，更全） | ⚠️ **content 侧更厚**（还带候选串认领、note 继承）→ 本仓库侧**只取了通用内核** |
| **图集断号检查** | ✅ `lib/preflight.cjs`（2026-10-26 新增） | ✅ `lib/preflight.mjs` | ✅ |
| **公众号草稿核验 + 素材复用** | ✅ `platforms/wechat.cjs verify` + `--material-ids`（2026-10-26 新增） | ✅ operation 版 `wechat.mjs` | ⚠️ 语义一致、代码各一份（**两边都是 API 通道，凭证共用**） |

**⚠️ 的三处说明**：
- 条件等待 / 长文本插入：两边**语义一致但代码各一份** —— 因为运行时的 API 不同
  （Playwright 的 `page.keyboard.insertText` vs ego lite 的 `page.keyboard.insertText`，
  但等待/回读封装写法不同）。**行为要一致，实现可以不同**。
- 体检：publish-kit 的 `preflight` 是**通用张数/长度检查**；content 的 `preflight.mjs`
  还包含**台账状态**检查（那边的台账是必需的，这边是可选的）。
- 台账：publish-kit 的台账**可选**（通用工具不该强绑）；content 的台账是**必需**
  （内容生产线的事实源）。

**同步纪律**：
1. 平台逻辑以 **publish-kit 为准**（开源主仓），回灌到 content 侧。
2. 回灌时**带上实测依据与日期** —— 没有依据的口径用软线。
3. 改了一边，**在另一边记一笔**（commit message 或本文件的同步清单）。
4. **不要指望代码共享** —— 两个独立仓库，漂移是默认状态，要靠纪律而不是机制。

---

## 八、自检

```bash
node selftest.cjs      # 104 项：等待 / 日志 / 体检 / 台账 / 编排 / 清单 / 诊断 / 截图 / 链接闸
```

改完 `lib/` 下任何模块后跑一次。改完平台脚本至少跑 `node --check platforms/<file>.cjs`。
