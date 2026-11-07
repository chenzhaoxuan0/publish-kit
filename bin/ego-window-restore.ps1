# ego-window-restore.ps1 — 把 ego lite 的浏览器窗口从「最小化」拉回可见
#
# 背景（2026-11-01 生产环境实测）：ego lite 窗口一旦最小化，填单会**集体假死** ——
#   ① 截图报 "Cannot capture a screenshot while the window is minimized."
#   ② page.fill / page.mouse.click 超时：CDP request timed out: Input.dispatchMouseEvent
#   ③ page.waitForFileChooser 永远不 fire（点击根本没生效）→ "点上传入口 3 次都没唤起文件选择器"
#   ④ 选择器型判据（知乎「发想法」/ 知乎视频上传入口）全部读不到元素
# → 根因不是平台改版，是**窗口最小化**。填单前先跑本脚本把窗口拉回来（幂等：
#   没有窗口就跳过；失败不阻断填单 —— 顶多退回原来的失败模式）。
#
# 用法：pwsh -File bin/ego-window-restore.ps1 [-ProcessName ego]
#   退出码：0 = 脚本正常执行（found=N restored=M）
#           2 = 没有找到目标进程
#
# ⚠️ 枚举回调里**不能用 `$var += ...`**（PowerShell 委托在子作用域执行，赋值丢失）
#    → 必须用 ArrayList 的 .Add()。2026-11-01 踩过这个坑。

param([string]$ProcessName = 'ego')

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class EgoWin2 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public const int SW_RESTORE = 9;
  public const int SW_SHOW = 5;
}
"@

$egoPids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if (-not $egoPids) { Write-Output 'NO_EGO_PROCESS'; exit 2 }

$found = New-Object System.Collections.ArrayList

# ⚠️ IME 辅助窗口（Default IME / MSCTFIME UI / HintWnd / 各家输入法的 *_TSF_UI）
#    挂在目标进程下但**不是浏览器窗口** → 一律跳过：
#    对它们调 ShowWindow 只会弄乱输入法状态，输出还全是噪音。
$IME_HELPERS = @('Default IME', 'MSCTFIME UI', 'HintWnd', 'Chatterfly_TSF_UI')

$cb = [EgoWin2+EnumWindowsProc]{
  param($h, $l)
  $procId = 0
  [void][EgoWin2]::GetWindowThreadProcessId($h, [ref]$procId)
  if ($egoPids -contains $procId) {
    $len = [EgoWin2]::GetWindowTextLength($h)
    $sb = New-Object System.Text.StringBuilder ($len + 2)
    if ($len -gt 0) { [void][EgoWin2]::GetWindowText($h, $sb, $sb.Capacity) }
    [void]$found.Add([pscustomobject]@{
      Hwnd      = $h
      ProcId    = $procId
      Title     = $sb.ToString()
      Visible   = [EgoWin2]::IsWindowVisible($h)
      Minimized = [EgoWin2]::IsIconic($h)
    })
  }
  return $true
}
[void][EgoWin2]::EnumWindows($cb, [IntPtr]::Zero)

if ($found.Count -eq 0) { Write-Output ('NO_EGO_WINDOW (pids=' + ($egoPids -join ',') + ')'); exit 0 }

$restored = 0
foreach ($w in $found) {
  # 跳过 IME 辅助窗口与无标题窗口（它们不是浏览器窗口）
  if ($IME_HELPERS -contains $w.Title) { continue }
  if ($w.Title -like '*_TSF_UI') { continue }   # 各家输入法的 TSF 辅助窗（搜狗/微软…）
  if ([string]::IsNullOrWhiteSpace($w.Title)) { continue }
  $state = if ($w.Minimized) { 'minimized' } elseif ($w.Visible) { 'visible' } else { 'hidden' }
  Write-Output ("WINDOW pid={0} state={1} title='{2}'" -f $w.ProcId, $state, $w.Title)
  if ($w.Minimized -or -not $w.Visible) {
    [void][EgoWin2]::ShowWindow($w.Hwnd, [EgoWin2]::SW_RESTORE)
    [void][EgoWin2]::ShowWindow($w.Hwnd, [EgoWin2]::SW_SHOW)
    [void][EgoWin2]::SetForegroundWindow($w.Hwnd)
    Write-Output ("  -> RESTORED pid={0} title='{1}'" -f $w.ProcId, $w.Title)
    $restored++
  }
}

Write-Output ("SUMMARY windows={0} restored={1}" -f $found.Count, $restored)
exit 0
