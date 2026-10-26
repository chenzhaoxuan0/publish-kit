---
name: publish-kit
description: |
  多平台社媒「自动填单」工具（publish-kit）。当用户要把**已经备好**的图集 / 视频 /
  文案填进抖音、微博、知乎、B站、视频号、公众号的**发布表单**时使用。

  核心行为：填完**停在「发布」按钮前**，发布由用户本人点击 —— 工具本身没有点发布的代码路径。

  触发词（看意图，不要只匹配关键词）：
  - "用 publish-kit 发"、"publish-kit 填单"、"把这期发到抖音/微博/B站"
  - "上传视频并填好发布表单"、"帮我把图集填进发布页"
  - "补个封面"、"改下合集/分类"、"公众号推草稿"

  不要触发：
  - 内容创作与改稿（写文案、做卡、做封面图）→ 那是内容生产环节，不是填单
  - 发布后的链接回填 / 数据回收 / 复盘统计
  - 小红书（**零自动化政策**：本工具没有小红书通道，也不要用别的工具替代）
  - 用户要的是「分析/对比/排版/翻译」而不是填单
---

# publish-kit

多平台图文 / 视频**自动填单**工具集。填完停在「发布」按钮前，**发布由用户本人点击**。

> **它是什么**：一个 Node CLI 工具集（`platforms/*.cjs`），程序化驱动一个**已登录的 Chrome**
> （通过 CDP 连 `config.yaml` 的 `runtime.cdp_url`），按各平台的真实 DOM 填表。
>
> **它不是什么**：不是内容生成器。它只做「把备好的物料填进表单」这一件事。
> 文案、图集、封面这些**上游产物由你（或用户）提供**。

---

## 何时用 / 何时不用

| 情况 | 走哪条 |
|---|---|
| 物料已备好，要填 1 个平台 | 本 skill，单平台脚本 |
| 物料已备好，要填多个平台（物料都一样） | 本 skill，`bin/publish-all.cjs` 并行 |
| **各平台物料不一样**（正文/标题/封面各不同） | 本 skill，**发布清单** `bin/publish-manifest.cjs` |
| 要写文案 / 做卡 / 出封面 | **不用本 skill**（那是内容生产环节） |
| 要回填发布链接 / 收数据 | **不用本 skill** |
| 小红书 | **无此通道**。备料 + 人工发布 |
| 要发的是直播 / 评论 / 私信 | **不用本 skill** |

---

## 绝对红线（违反任意一条都算任务失败）

1. **绝不点击「发布 / 发送 / 发表 / 提交投稿」按钮。**
   工具本身没有这条代码路径；你也**不要**用别的方式替用户点。
   终点 = 发布按钮前，然后告诉用户「请你自己点」。
2. **绝不自动登录、不过验证码、不碰 2FA。**
   登录态失效 → 让用户扫码，然后复核。
3. **绝不替用户猜业务字段**（分区 / 分类 / 合集 / 领域）。
   留空 = 脚本跳过 + 告警，这是**有意设计**：猜错的值会静默落到发布页上，用户可能发布前都没发现。
4. **绝不碰用户的浏览器 profile、不清 cookie、不注入指纹。**
   登录态在用户自己的 Chrome profile 里，脚本只连不碰。

---

## 决策流程

### ① 首次使用 / 环境不确定

```bash
cd <publish-kit 目录>          # 脚本要在 publish-kit 目录下跑（相对路径 + config.yaml 都在这）
node bin/doctor.cjs --no-launch   # 秒级体检：配置/依赖/Chrome/CDP/各平台登录态（不碰浏览器）
```

`doctor` 报什么就修什么。常见两类：

- **登录态失效** → `node bin/login.cjs <平台名>`（只开登录页，**让用户自己扫码**）→ 再 `node bin/doctor.cjs` 复核
- **找不到 config.yaml** → `node bin/init.cjs`（交互式向导，**不要手工造 config.yaml**）

### ② 判断这是「新填」还是「补投」

| 场景 | 命令 |
|---|---|
| 首次填单 | 平台脚本的默认用法（见下表） |
| 封面没生效 / 只传了一半 | `cover` 子命令（抖音/微博/知乎/视频号/B站都有） |
| 只改合集 / 分类 / 声明 | 抖音 `collect`、微博 `channel`、视频号 `fix` |
| 抖音分步（图文） | `open` → `upload` → `fill` → `music` → `collect` → `shot` |

⚠️ **重跑会毁单**：平台表单内容只在页面内存里，一次导航就丢。
所以所有脚本都有**交割护栏**——检测到页面已有内容就拒绝执行（除非 `--force`）。
**不要为了「让它跑通」就加 `--force`**，先搞清楚页面上是什么。

### ③ 填单

```bash
# 单平台（最常用）
node platforms/douyin.cjs --kind image --media ./cards --count 8 --title "标题" --body-file body.txt
node platforms/bilibili.cjs --video a.mp4 --title "标题" --body-file desc.txt --tags "AI,大模型" --cover c.png

# 多平台并行（一条命令）
node bin/publish-all.cjs --platforms douyin,weibo,zhihu --kind image \
     --media ./cards --count 8 --title "标题" --body-file body.txt

# 多平台 + 各平台物料不同 → 发布清单（推荐）
node bin/publish-manifest.cjs <清单.yaml> --dry-run     # 先看要跑什么
node bin/publish-manifest.cjs <清单.yaml> --check-only  # 只体检，不起浏览器
node bin/publish-manifest.cjs <清单.yaml>               # 真填单
```

⚠️ **抖音是多命令模型**（`open`→`upload`→`fill`→`music`/`collect`→`cover`→`shot`，
每步一个进程、靠浏览器里那个标签页续上下文）。**不要自己拼一条 `douyin.cjs` 命令**——
不带子命令时它只会 `open` 然后退出（**只开页、没填单，却报成功**）。
走清单模式或 `bin/publish-all.cjs` 才会展开成完整序列。

完整命令面（每个平台的参数、用法、坑位）见 **`references/commands.md`**。
发布清单的字段表见 **`docs/manifest.example.yaml`**。

### ④ 交割

脚本跑完后：

1. **看截图**（落 `publish.screenshot_dir`）—— 控制台说「已填」不等于填对了
2. 告诉用户「已停在发布按钮前，请你点发布」，附截图路径
3. **不要**自己点

⚠️ **截图失败 ≠ 发布失败**：判据全在 DOM，截图只是留档。
看到「⚠ 截图失败（已忽略，不影响填单结果）」**不要**当成失败重跑。

### ⑤ 失败了怎么办

编排层会自动诊断并给出**可执行**建议：

| 诊断级别 | 你的动作 |
|---|---|
| `channel-dead` 通道不可用 | **别再填单**。跑 `node bin/doctor.cjs`；平台可能改版 → 读该平台脚本头的坑位注释 |
| `login-required` 登录态失效 | `node bin/login.cjs <平台>` 让用户扫码。**不要自动重试** |
| `content-rejected` 物料被拒 | 改物料。**重试无意义** |
| `cosmetic` 仅截图失败 | 填单其实已经成了，通常不用管 |
| `retryable` 偶发失败 | 编排层已自动重试过一次；仍失败 → 按 `channel-dead` 处理 |

---

## 命令速查

| 线 | 平台 | 命令 |
|---|---|---|
| 图文 | 抖音 | `node platforms/douyin.cjs --kind image --media <dir> --count N --title "…" --body-file <f>` |
| 图文 | 微博 | `node platforms/weibo-image.cjs --media <dir> --count N --title "…" --body-file <f>` |
| 图文 | 知乎想法 | `node platforms/zhihu-pin.cjs --media <dir> --count N --body-file <f>` |
| 图文 | 公众号 | `node platforms/wechat.cjs push --media <dir> --title "…"`（**API，草稿箱**） |
| 视频 | 抖音 | `node platforms/douyin.cjs --kind video --file <mp4> --title "…" --body-file <f>` |
| 视频 | 微博 | `node platforms/weibo.cjs --video <mp4> --title "…" --body-file <f> --cover <png>` |
| 视频 | 知乎 | `node platforms/zhihu.cjs --video <mp4> --title "…" --body-file <f>` |
| 视频 | B站 | `node platforms/bilibili.cjs --video <mp4> --title "…" --body-file <f> --tags "a,b" --cover <png>` |
| 视频 | 视频号 | `node platforms/shipinhao.cjs --video <mp4> --title "…" --body-file <f> --cover <png>` |
| 全部 | 并行 | `node bin/publish-all.cjs --platforms a,b,c --kind image|video …` |
| 全部 | 发布清单 | `node bin/publish-manifest.cjs <清单.yaml> [--dry-run] [--check-only]` |
| 体检 | — | `node bin/doctor.cjs` · `node bin/login.cjs <平台>` |

⚠️ **平台侧硬限制**（超了平台会拦，脚本也会在起浏览器前体检拦下）：

| 平台 | 标题 | 正文 | 图/视频 | 话题 |
|---|---|---|---|---|
| 抖音 | 10–30（20 最佳） | ≤900 | 图 1–12 | ≤5 |
| 微博 | ≤30 | 软线 900 | — | 标签 `#tag#` 双 # 格式 |
| 知乎 | ≤80 | 软线 2000 | — | ≤10 |
| B站 | ≤80 | ≤2000 | — | 标签必填 |
| 视频号 | ≤16（硬约束） | ≤1000 | — | — |
| 公众号 | ≤32 | ≤1265 | ≤20 张 | — |

---

## 排障

| 现象 | 多半是 |
|---|---|
| `FATAL 找不到 config.yaml` | 没跑 init。`node bin/init.cjs` |
| `连不上 CDP` | Chrome 没起。`node bin/doctor.cjs`（不加 `--no-launch` 会自动拉起） |
| `端口被占用/拒绝访问` | 端口落在 Windows 保留段。`netsh interface ipv4 show excludedportrange protocol=tcp` 查了换 `runtime.cdp_url` |
| `未登录` | 让用户扫码。`node bin/login.cjs <平台>`，**不要试图自动登录** |
| `某平台未登录/字段未配置` | 正常。脚本会跳过并告警，转人工处理，**不要自己编一个值填上** |
| 选中的元素点不动 | 需要真实 `mouse.click` 而非合成 click，读该平台脚本头的坑位注释 |
| 视频传不进去（>50MB） | 走 `setVideoFile()`，不要自己写 `setInputFiles` |
| **抖音只开了页、没填单** | 抖音是多命令模型。走清单模式或 `bin/publish-all.cjs`，别自己拼单条命令 |
| **截图失败** | **不是发布失败**。判据全在 DOM，截图只是留档 |
| `invalid ip`（公众号） | 本机公网 IP 不在白名单。`node platforms/wechat.cjs ip` 看当前出口 IP → 后台加白名单 → 5–10 分钟生效 |
| 平台报「口径未确认」 | 平台可能改版了。读该平台脚本头的**坑位注释**（带实测日期），别靠反复实跑试探 |

更细的排障表见 **`references/troubleshooting.md`**。

---

## 改代码时

- **先读该平台脚本文件头的坑位注释**（那是本项目最贵的知识，每条都带实测日期）
- 平台硬限制是**平台规则**，不是可调默认值；别为了跑通改口径
- 通用能力在 `lib/`（等待 / 日志 / 体检 / 台账 / 编排），**优先用它，别各写各的**
- 改完 `lib/` 跑 `node selftest.cjs`；改完平台脚本跑 `node --check platforms/<file>.cjs`
- ⚠️ 调试纪律：出现「逻辑看着对但结果恒为空」时，**先写探针抓地面真相**，
  别在同一个假设上调参数。详见 `docs/capability-matrix.md` 第四节

---

## 参考

- `<publish-kit>/AGENTS.md` — 给 agent 的完整操作说明与决策点（**填单前读这个**）
- `<publish-kit>/README.md` — 人读的用法与设计说明
- `<publish-kit>/docs/capability-matrix.md` — 能力矩阵 + 实战坑位 + 多通道路线
- `<publish-kit>/references/commands.md` — 完整命令面
- `<publish-kit>/references/troubleshooting.md` — 排障详表
