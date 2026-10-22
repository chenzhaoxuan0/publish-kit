# 安装 publish-kit skill

本 skill 的**事实源在本仓库**（`skills/publish-kit/`），跟着仓库和 npm 包一起走。
装到你的 agent skills 目录后即可被调用。

---

## 方式 A：从仓库装（开发/贡献者，推荐）

```bash
git clone https://github.com/chenzhaoxuan0/publish-kit.git
cd publish-kit
npm install

# 把 skill 复制到你的 agent skills 目录
cp -r skills/publish-kit ~/.minimax/agents/mavis/skills/     # mavis
# 或
cp -r skills/publish-kit ~/.claude/skills/                  # claude code
```

**Windows（PowerShell）**：

```powershell
git clone https://github.com/chenzhaoxuan0/publish-kit.git
cd publish-kit
npm install
Copy-Item -Recurse skills\publish-kit "$env:USERPROFILE\.minimax\agents\mavis\skills\publish-kit"
```

---

## 方式 B：从 npm 装（使用者）

```bash
npm install -g publish-kit
npx publish-kit init      # 生成 config.yaml
npx publish-kit doctor    # 体检
```

skill 本体在 npm 包的 `skills/publish-kit/` 下：

```bash
npm root -g                       # 找到全局包目录
cp -r "$(npm root -g)/publish-kit/skills/publish-kit" ~/.minimax/agents/mavis/skills/
```

---

## 验证装好了

```bash
# 1. skill 在不在
ls ~/.minimax/agents/mavis/skills/publish-kit/
#   SKILL.md  references/commands.md  references/troubleshooting.md

# 2. 工具本体能不能跑
cd <publish-kit 目录>
node selftest.cjs        # 37 项自检，不连浏览器
node bin/doctor.cjs --no-launch
```

---

## 目录约定

```
publish-kit/
├── skills/publish-kit/          ← skill 本体（事实源）
│   ├── SKILL.md                 决策流程 + 红线 + 命令速查
│   └── references/
│       ├── commands.md          完整命令面（每平台参数/用法/坑位）
│       └── troubleshooting.md   排障详表
├── platforms/*.cjs              平台填单脚本
├── lib/                         横向能力层（等待/日志/体检/台账/编排）
├── bin/                         init / doctor / login / publish-all
└── AGENTS.md                    给 agent 的完整操作说明
```

---

## 用起来是什么样

agent 拿到「把这期发到抖音和 B站」这类需求时：

1. 读 `SKILL.md` → 知道红线（不点发布）、决策流程（先 doctor 再填单）
2. 需要具体参数 → 读 `references/commands.md`
3. 填完出问题了 → 读 `references/troubleshooting.md`
4. 填完 → 截图给用户，**让用户自己点发布**

---

## 更新

skill 跟着仓库走：

```bash
cd <publish-kit 目录>
git pull
# 重新复制到 skills 目录（或改用软链，见下）
```

**软链（省得每次复制）**：

```bash
# macOS / Linux
ln -s "$(pwd)/skills/publish-kit" ~/.minimax/agents/mavis/skills/publish-kit

# Windows（需管理员或开发者模式）
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.minimax\agents\mavis\skills\publish-kit" -Target "$(Get-Location)\skills\publish-kit"
```

⚠️ **软链是同一个文件的两条路径** —— 改仓库里的 skill，软链那边立即生效；
但反过来**删仓库目录会连带软链失效**（不是删 skill 本身）。
