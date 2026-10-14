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
