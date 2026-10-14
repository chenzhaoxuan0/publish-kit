# AGENTS.md

给 AI agent 的操作说明。**人类用户请读 [README.md](README.md)。**

这个文件假设你正在代替用户操作 publish-kit。以下是流程、决策点和不能碰的红线。

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

改完任何平台脚本后，至少跑一次 `node --check platforms/<file>.cjs`。
