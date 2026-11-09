<#
  让常驻调度器在用户登录时自动拉起（opt-in，写的是 HKCU，不需要管理员）。

    powershell -ExecutionPolicy Bypass -File ci\install-autostart.ps1
    powershell -ExecutionPolicy Bypass -File ci\install-autostart.ps1 -Remove

  和 install-task.ps1 的区别：
  - 计划任务每 5 分钟冷启动一轮（--once），有 ~10-30s 的 label 索引空转；
  - 这里是登录时拉一个常驻进程（--serve），之后每 60 秒轮询一次，重启机器才重来。
  两者可以并存：常驻进程持锁时，计划任务的 --once 会静默秒退（约 120ms），不刷日志。

  注册的命令是 `--ensure` 而不是 `--serve`：登录自启和手动重复点击都安全，
  已经有常驻进程时它只打印一句「已在运行」就退出，不会起第二个。
#>
param(
    [string]$Name = 'DSHDispatcher',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

if ($Remove) {
    Remove-ItemProperty -Path $key -Name $Name -ErrorAction SilentlyContinue
    Write-Host "已移除登录自启: $Name"
    exit 0
}

$repo = Split-Path -Parent $PSScriptRoot
$node = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe'

$required = @(
    $node,
    (Join-Path $repo 'ci\dispatch.mjs'),
    'D:\code\.secrets\github-token.txt',
    'D:\code\.secrets\askpass.sh'
)
foreach ($p in $required) {
    if (-not (Test-Path $p)) { throw "缺少: $p" }
}

$dispatch = Join-Path $repo 'ci\dispatch.mjs'

# 登录自启同样不该在桌面上闪一下控制台：HKCU Run 直接跑 node.exe（控制台程序）会创建黑窗。
# 改由 wscript.exe（GUI 子系统，自身无窗口）拉起隐藏的 node --ensure。
$hidden = Join-Path $repo '.logs\dispatch-autostart.vbs'
$hiddenDir = Split-Path -Parent $hidden
if (-not (Test-Path $hiddenDir)) { $null = New-Item -ItemType Directory -Path $hiddenDir -Force }
$vbs = @'
Dim sh, rc
On Error Resume Next
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "__REPO__"
rc = sh.Run("""__NODE__"" --use-system-ca "__DISPATCH__" --ensure", 0, False)
If Err.Number <> 0 Then
  WScript.Quit 1
End If
WScript.Quit rc
'@.Replace('__REPO__', $repo).Replace('__NODE__', $node).Replace('__DISPATCH__', $dispatch)
[IO.File]::WriteAllText($hidden, $vbs, (New-Object Text.UTF8Encoding($false)))

$command = 'wscript.exe //nologo "{0}"' -f $hidden

Set-ItemProperty -Path $key -Name $Name -Value $command

Write-Host "已注册登录自启: $Name"
Write-Host "  $command"

# 立刻生效一次（不等待它跑任务）
& $node --use-system-ca $dispatch --ensure
