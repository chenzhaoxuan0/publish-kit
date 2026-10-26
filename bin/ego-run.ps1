<#
.SYNOPSIS
  ego lite 脚本运行器（Windows / PowerShell）。

.DESCRIPTION
  ego-browser 的 nodejs 子命令**只有两种源码输入方式**：
    1. `-e "<script>"`            —— 内联源码
    2. `< script.js`              —— stdin 管道
  **没有文件参数模式**（`ego-browser nodejs x.mjs` 会报 "accepts at most one source argument"）。

  本运行器统一走 `-e` + 动态 import：
    ego-browser nodejs -e "await import('file:///C:/abs/path/x.mjs')"
  选这条而不是 stdin 的原因：**只有动态 import 能保住相对 import**。
  stdin 模式下脚本没有自己的文件 URL，`import './lib/x.mjs'` 会解析失败。

  同时解决三个 Windows 实战约束：
    a) ego-browser 可能不在当前终端的 PATH 里（PATH 注册在 User 级、当前进程早于注册）。
       本脚本依次尝试：PATH → User PATH 里的 junction → 已知安装目录。
    b) ego 运行时不继承环境变量，也不透传 argv（实测 process.env / process.argv 均拿不到调用方参数）。
       所以参数通过「生成一个 wrapper .mjs」注入：wrapper 里先把 globalThis.__OP_ARGS__
       设好，再 import 真正的脚本。脚本用 `readArgs()` 取。
    c) 运行时的 cwd 是 ego lite 的安装目录，不是本工作区。脚本内一切路径都必须是绝对路径。

.EXAMPLE
  pwsh -File bin/ego-run.ps1 -Script 04_skills/ego-publish/platforms/weibo.mjs `
        -ScriptArgs @{ media = 'C:/x/img'; bodyFile = 'C:/x/body.md'; count = 6 }
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Script,

  # 参数可以是三种形式：
  #   1) hashtable  —— 在同一 PowerShell 进程里调用时用：
  #                     & bin/ego-run.ps1 -Script x.mjs -ScriptArgs @{ a = 1 }
  #   2) JSON 字符串 —— 用 `pwsh -File` 调用时用（-File 会把所有参数当字符串传，
  #                     hashtable 表达式不成立）：
  #                     pwsh -File bin/ego-run.ps1 -Script x.mjs -ScriptArgs '{"a":1}'
  #   3) 走 -ArgsFile 读一个 JSON 文件（最省事，命令行零引号 trouble）
  [Parameter(Position = 1)]
  [object]$ScriptArgs,

  # 从 JSON 文件读参数（推荐给 agent 用：写文件比在命令行里转义引号可靠）
  [string]$ArgsFile,

  # 只打印将要执行的命令，不实际运行
  [switch]$WhatIfOnly,

  # 显式指定 ego-browser 可执行文件（对比版本 / 临时绕开某个坏版本用）
  [string]$EgoExe
)

$ErrorActionPreference = 'Stop'

# ── 1. 解析脚本绝对路径 ────────────────────────────────────────────────
$scriptPath = if ([IO.Path]::IsPathRooted($Script)) {
  [IO.Path]::GetFullPath($Script)
} else {
  [IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Script))
}
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  Write-Error "脚本不存在: $scriptPath"
}

# ── 2. 解析 ego-browser 可执行文件 ────────────────────────────────────
function Resolve-EgoBrowser {
  # 2a. 显式指定（最高优先级）—— 用来对比版本、临时绕开某个坏版本
  if ($EgoExe) {
    if (Test-Path -LiteralPath $EgoExe) { return (Resolve-Path -LiteralPath $EgoExe).Path }
    Write-Error "指定的 ego-browser 不存在: $EgoExe"
  }

  # 2b. 当前进程 PATH
  $cmd = Get-Command 'ego-browser' -CommandType Application -ErrorAction SilentlyContinue |
         Where-Object { $_.Source -like '*ego*' } | Select-Object -First 1
  if ($cmd) { return $cmd.Source }

  # 2c. User 级 PATH 里注册的 junction（路径可能用 / 或 \ 混写）
  #     ⚠️ 这个 junction 可能**落后于已安装的最新版本**（ego lite 每天自动升级，
  #       实测 2026-10-24 06:51 0.6.0.20 → 0.6.0.22，而 junction 还指着 0.6.0.20）。
  #       **但顺序不能改**：实测 0.6.0.22 的 CLI 在 agent 沙箱里
  #       「Failed to connect to ego_cli bootstrap」（exit 5），根本跑不起来；
  #       而 0.6.0.20 的 CLI 与 0.6.0.22 的 GUI 混用**填单完全正常**
  #       （2026-10-24 12:13 之后微博/抖音/知乎都跑通了）。
  #       → 所以：**junction 优先，最新安装版本只作兜底**。
  #       → 真要升 ego lite，得在沙箱外（或 Full Access）跑 `ego-browser upgrade`。
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath) {
    foreach ($entry in ($userPath -split ';')) {
      if (-not $entry) { continue }
      $hit = Join-Path $entry.Trim() 'ego-browser.exe'
      if (Test-Path -LiteralPath $hit) { return (Resolve-Path -LiteralPath $hit).Path }
    }
  }

  # 2d. 已知安装目录（取版本号最大的一个）—— 兜底
  $roots = @()
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
    if (-not $base) { continue }
    $cand = @(
      (Join-Path $base 'Citro Labs\ego lite\Application'),
      (Join-Path $base 'Programs\Citro Labs\ego lite\Application')
    )
    foreach ($c in $cand) { if (Test-Path -LiteralPath $c) { $roots += $c } }
  }

  $best = $null; $bestVer = $null
  foreach ($root in $roots) {
    foreach ($ver in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      $hit = Join-Path $ver.FullName 'ego-browser.exe'
      if (Test-Path -LiteralPath $hit) {
        try { $v = [version]$ver.Name } catch { continue }
        if (-not $bestVer -or $v -gt $bestVer) { $bestVer = $v; $best = $hit }
      }
    }
  }
  if ($best) { return $best }
  return $null
}

$egoExe = Resolve-EgoBrowser
if (-not $egoExe) {
  Write-Error @"
未找到 ego-browser 可执行文件。
  ego lite 需要先安装并完成 onboarding（https://lite.ego.app/）。
  本机已知的安装位置：
    $env:ProgramFiles\Citro Labs\ego lite\Application\<版本>\ego-browser.exe
"@
}

# ── 3. 把文件路径转成 file:// URL（percent-encode，避免引号/空格问题）──
function ConvertTo-FileUrl([string]$absPath) {
  $p = $absPath -replace '\\', '/'
  # 保留盘符冒号，其余按 URL 规则编码
  $p = $p -replace ' ', '%20'
  $p = $p -replace '#', '%23'
  $p = $p -replace '\?', '%3F'
  $p = $p -replace '&', '%26'
  $p = $p -replace "'", '%27'
  $p = $p -replace '"', '%22'
  return "file:///$p"
}

# ── 4. 生成 wrapper：先注入参数，再 import 真正的脚本 ──────────────────
# 用**每次唯一**的文件名（并行跑多个平台时不会互相覆盖 —— 这是并行发布的前提）。
# 固定目录 + 唯一文件名：不产生目录垃圾，也不写任何删除动作
# （本机 Remove-Item 被安全策略硬挡）。
$runDir = Join-Path $env:TEMP 'ego-pk-runner'
if (-not (Test-Path -LiteralPath $runDir)) {
  New-Item -ItemType Directory -Path $runDir -Force | Out-Null
}
$wrapperName = 'run-' + [guid]::NewGuid().ToString('N').Substring(0, 10) + '.mjs'
$wrapperPath = Join-Path $runDir $wrapperName

# 参数归一化：hashtable / JSON 字符串 / JSON 文件 → 一份 hashtable
$resolvedArgs = @{}
if ($ArgsFile) {
  $af = if ([IO.Path]::IsPathRooted($ArgsFile)) { $ArgsFile } else { Join-Path (Get-Location).Path $ArgsFile }
  if (-not (Test-Path -LiteralPath $af)) { Write-Error "参数文件不存在: $af" }
  $raw = [IO.File]::ReadAllText($af)
  $obj = $raw | ConvertFrom-Json -AsHashtable
  if ($obj) { foreach ($k in $obj.Keys) { $resolvedArgs[$k] = $obj[$k] } }
} elseif ($ScriptArgs -is [string]) {
  if ($ScriptArgs.Trim()) {
    $obj = $ScriptArgs | ConvertFrom-Json -AsHashtable
    if ($obj) { foreach ($k in $obj.Keys) { $resolvedArgs[$k] = $obj[$k] } }
  }
} elseif ($ScriptArgs -is [System.Collections.IDictionary]) {
  foreach ($k in $ScriptArgs.Keys) { $resolvedArgs[$k] = $ScriptArgs[$k] }
} elseif ($null -ne $ScriptArgs) {
  Write-Error "无法识别的参数类型: $($ScriptArgs.GetType().FullName)。用 hashtable、JSON 字符串，或 -ArgsFile。"
}

$argsJson = ($resolvedArgs | ConvertTo-Json -Depth 6 -Compress)
if (-not $argsJson) { $argsJson = '{}' }

$wrapper = @"
// 由 ego-run.ps1 自动生成的参数注入 wrapper —— 不要手改，每次运行都会重建。
globalThis.__OP_ARGS__ = $argsJson;
await import('$(ConvertTo-FileUrl $scriptPath)');
"@
[IO.File]::WriteAllText($wrapperPath, $wrapper, (New-Object System.Text.UTF8Encoding($false)))

# ── 5. 执行 ────────────────────────────────────────────────────────────
# 注意：这里**不要**用数组 splat（& $egoExe @cmd）——实测在本机 pwsh 里会拆坏参数。
# 必须直接调用，见下面注释。

if ($WhatIfOnly) {
  Write-Host "ego-browser : $egoExe"
  Write-Host "script     : $scriptPath"
  Write-Host "args       : $argsJson"
  Write-Host "command    : ego-browser nodejs -e `"await import('<wrapper>')`""
  exit 0
}

Write-Host "[ego-run] exe     : $egoExe" -ForegroundColor DarkGray
Write-Host "[ego-run] script  : $scriptPath" -ForegroundColor DarkGray
Write-Host "[ego-run] args    : $argsJson" -ForegroundColor DarkGray

# ⚠️ 必须用「直接调用」而不是数组 splat（& $exe @cmd）。
#    实测：在本机 pwsh 里数组 splat 会把参数拆坏，ego CLI 收到
#    "-e/--eval must be used with `ego-cli nodejs`"；
#    直接调用 & $exe nodejs -e $evalScript 才能把 -e 的值完整传过去。
$evalScript = "await import('$(ConvertTo-FileUrl $wrapperPath)')"

& $egoExe nodejs -e $evalScript
$code = $LASTEXITCODE

exit $code
