# publish-kit 完整命令面

> 每个平台脚本的**文件头**有最权威的用法与坑位注释（含实测日期）。
> 本文是**速查**：参数、必填性、硬限制、坑位提示。
>
> ⚠️ **所有脚本必须在 publish-kit 目录下执行**（相对路径 + `config.yaml` 都在那）。

---

## 全局

### 环境准备

```bash
npm install                    # 装 patchright（唯一的运行时依赖）
node bin/init.cjs              # 交互式向导 → 生成 config.yaml（**必须先跑**）
node bin/doctor.cjs            # 体检：Node/依赖/Chrome/profile/CDP/各平台登录态
node bin/doctor.cjs --no-launch  # 同上但不碰浏览器（CI / 正在用同一个 Chrome 时）
node bin/login.cjs 抖音 B站      # 打开登录页，**让用户自己扫码**
node bin/login.cjs --all       # 所有平台
```

### 并行编排

```bash
node bin/publish-all.cjs --platforms douyin,weibo,zhihu --kind image \
     --media ./cards --count 8 --title "标题" --body-file body.txt

node bin/publish-all.cjs --platforms douyin,weibo,zhihu,bilibili,shipinhao --kind video \
     --video a.mp4 --title "标题" --body-file desc.txt --cover c.png --tags "AI,大模型" \
     --concurrency 5
```

| 参数 | 说明 |
|---|---|
| `--platforms` | 逗号分隔的平台 key（省略 = config.yaml 里所有 enabled 的） |
| `--kind` | `image` / `video` |
| `--concurrency` | 并发上限，**默认 5**（9 全并发会触发平台侧限流；降到 5 反而更快） |
| `--content-key` | 内容标识。配了 `publish.ledger` 时用于**防重复发布闸门** |
| `--allow-repeat` | 显式允许重复（绕过台账闸门） |
| 物料参数 | `--media/--count/--title/--body-file/--video/--cover/--tags`，透传给各平台脚本 |

⚠️ **物料不全会秒级报错且不启动任何平台脚本**（编排器会并发起 N 个进程连你的浏览器，
物料不全就别启动）。

### 发布清单（各平台物料不同 → 用这个）

```bash
node bin/publish-manifest.cjs <清单.yaml>              # 真填单
node bin/publish-manifest.cjs <清单.yaml> --dry-run    # 只打印将要跑什么
node bin/publish-manifest.cjs <清单.yaml> --check-only # 只体检，不起浏览器
node bin/publish-manifest.cjs <清单.yaml> --variants image --only douyin,zhihu
node bin/publish-manifest.cjs <清单.yaml> --concurrency 5 --content-key "2026-10-26_x"
```

| 参数 | 说明 |
|---|---|
| `--variants` | 只要这几个分发变体（逗号分隔） |
| `--only` | 只要这几个平台（逗号分隔） |
| `--dry-run` | 只打印命令，不执行 |
| `--check-only` | 只做体检（清单校验 + 物料存在性） |
| `--concurrency` | 并发上限，默认 5 |
| `--content-key` | 防重复闸门用的内容标识（清单里写了 `content.key` 就用它） |
| `--allow-repeat` | 显式允许重复（绕过台账闸门） |
| `--no-retry` | 关闭失败自动重试 |

清单字段全表见 `<publish-kit>/docs/manifest.example.yaml`。要点：

- 槽位字段：`platform` `via` `kind` `title` `titleFile` `bodyFile` `media` `count`
  `video` `cover` `covers[]` `tags`/`tagsFile` `options` `limits` `weight`
  `exclusive` `releaseFile` `note`
- **`via`**：`browser`（默认）/ `api`（公众号）/ `manual`（**零自动化，只备料**）
- **`options`** 是平台专属开关，写表外的**直接报错**（不静默丢）：
  抖音 `album`/`music`、微博 `channel`/`sub`/`no_declare`、
  知乎 `field`/`title_in_body`、视频号 `album`/`location`
- **路径相对清单文件所在目录**

### 自检

```bash
node selftest.cjs              # 104 项：等待/日志/体检/台账/编排/清单/诊断/截图/链接闸，不连浏览器
```

---

## 图文线

### 抖音 —— `platforms/douyin.cjs --kind image`

```bash
node platforms/douyin.cjs --kind image --media <dir> --count 8 --title "标题" --body-file <f>
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--media` | ✅ | 图集目录，按 `img-01.png` 起连续命名 |
| `--count` | ✅ | 实际张数（1–12） |
| `--title` | ✅ | 独立标题框（≤20 字，平台建议 10–30） |
| `--body-file` | ✅ | 纯文本正文（≤900 字） |

分步模式（**抖音图文**是唯一分步的平台，因为图集会被重置）：

```bash
node platforms/douyin.cjs open   --kind image
node platforms/douyin.cjs upload --kind image --media <dir> --count 8
node platforms/douyin.cjs fill   --kind image --title "标题" --body-file <f>
node platforms/douyin.cjs music  --kind image [--music "Opus 37"]   # 配乐（仅图文线）
node platforms/douyin.cjs collect --kind image --album "每日新闻"     # 合集 + 自主声明
node platforms/douyin.cjs shot   --kind image
```

坑位：
- **批量多选不可靠**（实测 8 次在 6/6、1/6、0/6 间跳）→ 脚本已改**逐张传**
- **「已添加 N 张」文字计数不可信**（统计的是上传队列）→ 脚本数**实际渲染的缩略图**
- 话题必须走联想面板；候选里**浏览量 0 的是回显假候选**，脚本只认浏览量 > 0 的
- **配乐只对图文线有**（视频线是视频自带音轨）

### 微博九宫格 —— `platforms/weibo-image.cjs`

```bash
node platforms/weibo-image.cjs --media <dir> --count 8 --title "标题" --body-file <简介.txt>
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--media` | ✅ | 图集目录 |
| `--count` | ✅ | 实际张数 |
| `--title` | — | **并入正文首行**（微博九宫格没有独立标题框） |
| `--body-file` | ✅ | 纯文本正文 |
| `--no-declare` | — | 本次不代填「内容由AI生成」声明 |

坑位：
- **微博的标签必须是 `#tag#`（双 # 包裹）** —— 单 # 服务端**不认**，发布出来是死文本。
  稿件层写对即可，发布端不做二次处理
- 计数判据已限定在 composer（`.wbpro-form`）内 —— 「6 张只进 1 张」也会判成功的老坑已修
- 点「图片」前会先等 composer 就绪（不然只进去 1 张）

### 知乎想法 —— `platforms/zhihu-pin.cjs`

```bash
node platforms/zhihu-pin.cjs --media <dir> --body-file <简介.txt> [--count 6]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--media` | ✅ | 图集目录 |
| `--body-file` | ✅ | 纯文本正文（**不含话题**，话题单独传） |
| `--count` | — | 默认 6 |
| `--title` | — | 并入正文首行（无独立标题框） |
| `--title-in-body` | — | 标题**也**保留在正文里 |
| `--manual-images` | — | 降级开关：跳过未跑通的自动配图块（自己贴图） |

坑位：
- 编辑器是 **Draft.js**，必须键盘输入 / insertText，直接设 `innerHTML` 不落 React state
- 补传走 Modal 内的「本地上传」，**每张必须看到计数真的 +1**
- 图文与视频会互相毁掉 → 视频脚本一律**另开新页**跑

### 公众号贴图 —— `platforms/wechat.cjs`（**走 API，不经浏览器**）

```bash
node platforms/wechat.cjs ip                        # 查当前公网出口 IP（家宽动态 IP 会变）
node platforms/wechat.cjs check                     # 连通性检查（取 token，无写入）
node platforms/wechat.cjs push --media <dir> --title "标题" [--body-file <f>] [--count N]
node platforms/wechat.cjs verify --media-id <id>    # 只读核查草稿在不在（不新增素材）
```

| 参数 | 说明 |
|---|---|
| `--media` | 图片目录；**排除 `*_blank*`**；顺序 = cover 最先 → 编号其次 → end 最后；**首张即封面** |
| `--title` | ≤32 字（newspic 硬上限） |
| `--body-file` | 纯文本配文（≤1265 字符硬上限） |
| `--count` | 取前 N 张 |
| `--app-id` | 临时换一个 AppID（secret 仍取自配置） |
| `--material-ids` | **复用已上传素材重建草稿**（不重新上传、不占新配额）。数量必须与要贴的图数一致，不一致直接报错 |
| `--content-key` | 启用防重复闸门（**在上传任何素材之前**就拦） |
| `--variant` | 台账变体（与编排层写回台账用的变体保持一致） |
| `--allow-repeat` | 显式允许重复 |

**push 成功后固定输出两行**（给编排层解析）：

```
MATERIAL_IDS: <逗号分隔>     # 本次用到的素材 media_id（上传完成即打）
DRAFT_MEDIA_ID: <草稿 id>   # 草稿进箱后打
```

**verify 的退出码语义**（编排层要区分）：

| 退出码 | 含义 | 该怎么办 |
|---|---|---|
| 0 | `DRAFT_VERIFY: ok media_id=… title=…` | 草稿在，一切正常 |
| 1 | `DRAFT_VERIFY: not_found media_id=…` | 草稿**真的不在** → 用上面的 `MATERIAL_IDS` 重建 |
| 2 | `DRAFT_VERIFY: error media_id=… reason=…` | **查不动**（凭证/接口问题）—— 当成 1 会误判成「草稿不在」→ 白重传素材、 白占配额 |

**终点是草稿箱。** 个人主体账号的发布类 API 权限已被官方回收，脚本不碰那些接口。

坑位：
- `invalid ip`（errcode 40164）→ 本机 IP 不在白名单，**不是 bug**
- 内容上限比看起来小：标题 32 / 正文 1265 / 20 张
- 凭证三选一（优先级从高到低）：环境变量 `WECHAT_APP_ID`/`WECHAT_APP_SECRET` → `--app-id` → `config.yaml`
- **公众号素材是永久素材** → 重跑 = 白占素材库配额（清理要去 mp 后台人工删）→ **API 通道永不自动重跑**

---

## 视频线

### 抖音视频 —— `platforms/douyin.cjs --kind video`

```bash
node platforms/douyin.cjs open   --kind video
node platforms/douyin.cjs upload --kind video --file <mp4>
node platforms/douyin.cjs fill   --kind video --title "标题" --body-file <f>
node platforms/douyin.cjs cover  --kind video --vertical <3x4.png> [--horizontal <4x3.png>]
node platforms/douyin.cjs collect --kind video --album "每日新闻"
node platforms/douyin.cjs shot   --kind video
```

坑位：
- **双封面**：竖 3:4 + 横 4:3，两张都给最稳
- 封面模式判据 = 步骤条里 class 含 `step-active` 的那项；**「没步骤条」≠ 错**
  （那是单模式直传面板，模式由所点槽位决定 —— 早期版本在这里 FATAL，会中止整条线）
- 封面 src 基线必须在**上传之前**取（否则拿「已落上的封面」和「已落上的封面」比）
- 视频页标题框 placeholder 与图文页**不同** → 用 `input[placeholder*="作品标题"]` 通配
- 页面有段帮助文案「如作品还在上传中…」含「上传中」但**不是进度** → 判据要排除

### 微博视频 —— `platforms/weibo.cjs`

```bash
node platforms/weibo.cjs --video <mp4> --title "标题" --body-file <描述.txt> [--cover <3x4.png>]
node platforms/weibo.cjs cover  --cover <png>        # 封面补投
node platforms/weibo.cjs fill   --title "标题" --body-file <描述.txt>   # 正文补投
node platforms/weibo.cjs channel --channel "科技数码" [--sub "科技"]     # 分类频道补投
```

坑位：
- **分类频道是级联双栏**：一级在左、二级在右，选一级后才能选二级
- 内容声明触发器文案与面板容器 class 都会改版 → 以脚本当前的判据为准
- 封面走**原生 filechooser**（`resolveOpenFileChooser`），不能直塞 input
- `a` 标签入口必须**真实 mouse.click**，合成 click 会重置整页表单

### 知乎视频 —— `platforms/zhihu.cjs`

```bash
node platforms/zhihu.cjs --video <mp4> --title "标题" --body-file <描述.txt>
node platforms/zhihu.cjs cover --cover <png>
```

| 参数 | 说明 |
|---|---|
| `--field` | 所属领域（如「科技互联网」），未配置 = 跳过 + 告警 |
| `--cover` | 3:4 封面（平台建议比例） |

坑位：
- **视频必须另开新页**（否则把想法页冲掉）
- 封面生效判据 = 出现 zhimg CDN/blob 预览；没有就**存失败截图**并报错

### B站 —— `platforms/bilibili.cjs`

```bash
node platforms/bilibili.cjs --video <mp4> --title "标题" --body-file <简介.txt> \
     --tags "AI,大模型" [--tags-file <f>] --cover <4x3.png> [--cover-16x9 <16x9.png>]
node platforms/bilibili.cjs cover --cover <png> [--cover-16x9 <png>]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--tags` / `--tags-file` | ✅ | **不传直接报错**（不设默认标签，避免静默落错） |
| `--cover` | — | 4:3 主封面 |
| `--cover-16x9` | — | 16:9 封面（双比例都传最稳） |

坑位：
- **浏览器级通知权限弹窗会硬停整个脚本** → 脚本已在上传前 `grantPermissions` 预授权
- 封面弹窗的「完成」是 **div 不是 button** → 任意元素文本匹配
- 简介空行问题：CRLF → LF + 压多余换行

### 视频号 —— `platforms/shipinhao.cjs`

```bash
node platforms/shipinhao.cjs open                              # 只开壳首页（人工登录用）
node platforms/shipinhao.cjs --video <mp4> --title "短标题" --body-file <描述.txt> [--cover <png>]
node platforms/shipinhao.cjs cover --cover <png>                # 封面补投
node platforms/shipinhao.cjs fix [--title "新短标题"] [--album "合集名"] [--cover <png>]
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--title` | ✅ | **≤16 字是硬约束**（平台短标题） |
| `--album` | — | 合集名，未配置 = 跳过 + 告警 |
| `--location` | — | `off` = 位置设为「不显示位置」 |
| `--cover` | — | 3:4 封面（平台建议比例） |

坑位：
- **上传区是 Ant Design 拖拽区**，`<input type=file>` 是隐藏的 →
  **直塞 input 文件不落表单**（老代码就这么错的，「视频已提交」其实没提交）
  → 脚本改成找 input 的**可见祖先**并点击，且递归进 `shadowRoot`（wujie 微前端）
- 封面弹窗的「确认」按钮要**等它渲染出来**（约 10s），固定短等待会误判
- 描述是 `pre-wrap` 文本节点，**每个 Enter 产生字面换行** → CRLF 会渲出 3 个空行

---

## 平台硬限制速查

| 平台 | 标题 | 正文 | 图 | 视频 | 话题/标签 |
|---|---|---|---|---|---|
| 抖音 | 10–30（20 最佳，框内上限 20） | ≤900（视频 ≤1000 顶格截断） | 1–12 张 3:4 | — | ≤5 |
| 微博 | ≤30（`maxlength=30`） | 软线 900 | — | — | 标签 `#tag#` |
| 知乎 | ≤80 | 软线 2000 | — | — | ≤10 |
| B站 | ≤80 | ≤2000 | — | — | 标签必填 |
| 视频号 | **≤16（硬约束）** | ≤1000 | — | — | — |
| 公众号 | ≤32 | ≤1265 字符 | ≤20 张（首张即封面） | — | — |

> 口径来源：B站 2000/80、视频号 1000/16、公众号 1265/32 是**实测回显**；
> 微博/知乎的正文 2000 是**软线**（无实测平台硬上限，超了由平台自己拦）——
> 脚本里硬闸只用于**有实测依据**的口径。
