<#
  把调度器注册成 Windows 计划任务（opt-in，不会自动执行）。

    powershell -ExecutionPolicy Bypass -File ci\install-task.ps1
    powershell -ExecutionPolicy Bypass -File ci\install-task.ps1 -EveryMinutes 2
    powershell -ExecutionPolicy Bypass -File ci\install-task.ps1 -Remove

  设计要点：
  - 每次触发只跑一轮（--once），不常驻；进程崩溃不会影响下一次触发。
  - MultipleInstances IgnoreNew：上一轮还没跑完时不会叠加第二轮。
  - 每轮有 40 分钟硬上限，卡死会被系统杀掉。
  - 动作带 --unattended：无人值守模式（拒单→needs-info、成本/门禁 fail-closed）。
  - 任务动作只依赖 node + 仓库路径，token 由 dispatch.mjs 自己从
    D:\code\.secrets\github-token.txt 读取，不写进任务定义。
#>
param(
    [int]$EveryMinutes = 5,
    [string]$TaskName = 'DSH Agent Dispatcher',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已移除计划任务: $TaskName"
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

# 每 5 分钟一次的空转不该在桌面上闪一下控制台：任务直接跑 node.exe（控制台程序）会创建黑窗。
# 改由 wscript.exe（GUI 子系统，自身无窗口）拉起隐藏的 node；Run(cmd, 0, True) 等它跑完并
# 把真实退出码交回任务计划程序（LastTaskResult 仍可监控）。
$hidden = Join-Path $repo '.logs\dispatch-hidden.vbs'
$hiddenDir = Split-Path -Parent $hidden
if (-not (Test-Path $hiddenDir)) { $null = New-Item -ItemType Directory -Path $hiddenDir -Force }
$vbs = @'
Dim sh, rc
On Error Resume Next
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "__REPO__"
rc = sh.Run("""__NODE__"" --use-system-ca ci/dispatch.mjs --once --unattended", 0, True)
If Err.Number <> 0 Then
  WScript.Quit 1
End If
WScript.Quit rc
'@.Replace('__REPO__', $repo).Replace('__NODE__', $node)
[IO.File]::WriteAllText($hidden, $vbs, (New-Object Text.UTF8Encoding($false)))
$action = New-ScheduledTaskAction `
    -Execute 'wscript.exe' `
    -Argument ('//nologo "' + $hidden + '"') `
    -WorkingDirectory $repo

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
    -RepetitionDuration ([TimeSpan]::FromDays(3650))

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 40)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Force `
    -Principal (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited) `
    -Description "DSH agent dispatcher: poll agent:ready issues every $EveryMinutes min" | Out-Null

Write-Host "已注册计划任务: $TaskName (每 $EveryMinutes 分钟一轮)"
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table
