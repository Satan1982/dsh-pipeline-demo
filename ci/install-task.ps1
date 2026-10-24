<#
  把调度器注册成 Windows 计划任务（opt-in，不会自动执行）。

    powershell -ExecutionPolicy Bypass -File ci\install-task.ps1
    powershell -ExecutionPolicy Bypass -File ci\install-task.ps1 -EveryMinutes 2
    powershell -ExecutionPolicy Bypass -File ci\install-task.ps1 -Remove

  设计要点：
  - 每次触发只跑一轮（--once），不常驻；进程崩溃不会影响下一次触发。
  - MultipleInstances IgnoreNew：上一轮还没跑完时不会叠加第二轮。
  - 每轮有 40 分钟硬上限，卡死会被系统杀掉。
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
$node = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'

$required = @(
    $node,
    (Join-Path $repo 'ci\dispatch.mjs'),
    'D:\code\.secrets\github-token.txt',
    'D:\code\.secrets\askpass.sh'
)
foreach ($p in $required) {
    if (-not (Test-Path $p)) { throw "缺少: $p" }
}

$action = New-ScheduledTaskAction `
    -Execute $node `
    -Argument '--use-system-ca ci/dispatch.mjs --once' `
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
    -Description "DSH agent dispatcher: poll agent:ready issues every $EveryMinutes min" | Out-Null

Write-Host "已注册计划任务: $TaskName (每 $EveryMinutes 分钟一轮)"
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table
