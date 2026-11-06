# ci/s4-stub-launcher.ps1 —— 测试替身：不跑真 agent，按环境变量写 done.json。
#
# 为什么要它：s4-job 的排队/隔离/失败语义都是「launcher 行为」的函数，用真模型验证一次要 20 秒
# 且依赖 Lemonade 是否空闲，不适合放进自检。这个替身只做两件事：可选睡一会儿、写 done.json。
#
#   S4_STUB_SLEEP=2500   # 毫秒，模拟一单的耗时（并发/串行判据靠它）
#   S4_STUB_FAIL=1       # 写 ok=false / exit=7，模拟任务自身失败
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$JobDir)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$jobFile = Join-Path $JobDir 'job.json'
$doneFile = Join-Path $JobDir 'done.json'

$sleepMs = 0
if ($env:S4_STUB_SLEEP) { $sleepMs = [int]$env:S4_STUB_SLEEP }
if ($sleepMs -gt 0) { Start-Sleep -Milliseconds $sleepMs }

$job = [System.IO.File]::ReadAllText($jobFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$fail = ($env:S4_STUB_FAIL -eq '1')
$done = [ordered]@{
  ok        = (-not $fail)
  exit      = $(if ($fail) { 7 } else { 0 })
  error     = $(if ($fail) { 'stub failure' } else { '' })
  user      = 'dsh-agent'
  task      = $job.task
  endedAt   = (Get-Date).ToString('o')
  tail      = @()
}
[System.IO.File]::WriteAllText($doneFile, ($done | ConvertTo-Json -Depth 4), $utf8)
exit 0
