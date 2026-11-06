# s4-run-headless.ps1 — 低权 headless 任务的进程入口（由计划任务 DSHAgentHeadless 以 dsh-agent 身份启动）
#
# 它不读任何凭据：账本/dsh-agent 自己的 home 里没有 .credentials.yaml，
# 且下面会显式清掉可能从父进程漏下来的密钥变量（同 ci/dispatch.mjs:1850 的 SCRUB_ENV 口径）。
#
# 契约（job 目录）:
#   输入  <JobDir>\job.json    { "task": "任务文本", "timeoutSec": 2400, "cwd": "D:\\code\\.worktrees\\issue-7" }
#         cwd 可选，缺省为 -Repo；只接受 D:\code\.worktrees 下的目录（防越权）。
#   输出  <JobDir>\headless.log   事件流（--json）
#         <JobDir>\headless.err   stderr
#         <JobDir>\done.json     { ok, exit, user, startedAt, endedAt, durationSec, verdict, tail }
#
# 退出码: 0 = 任务 exit 0；1 = 任务失败；2 = 环境问题（没起 bash / 缺 DSH_INSTALL）。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$JobDir,
  [string]$Install = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness',
  [string]$Repo = 'D:\code\dsh-pipeline-demo'
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Done([hashtable]$doc) {
  $path = Join-Path $JobDir 'done.json'
  [System.IO.File]::WriteAllText($path, ($doc | ConvertTo-Json -Depth 4), $Utf8NoBom)
}

$started = (Get-Date)
$done = @{
  ok = $false; exit = $null; user = $env:USERNAME; startedAt = $started.ToString('o')
  endedAt = $null; durationSec = 0; verdict = ''; tail = @(); error = ''
}

if (-not (Test-Path -LiteralPath $JobDir)) { New-Item -ItemType Directory -Path $JobDir -Force | Out-Null }

try {
  $jobFile = Join-Path $JobDir 'job.json'
  if (-not (Test-Path -LiteralPath $jobFile)) { throw ('缺 ' + $jobFile) }
  $job = [System.IO.File]::ReadAllText($jobFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $task = [string]$job.task
  if ([string]::IsNullOrWhiteSpace($task)) { throw 'job.json 里 task 为空' }
  $timeoutSec = 2400
  if ($job.timeoutSec) { $timeoutSec = [int]$job.timeoutSec }

  # 工作目录：调度器传的是某个 worktree；只允许 .worktrees 下面（agent 本来也只有那里的写权）
  $work = $Repo
  if ($job.cwd) {
    $cand = [string]$job.cwd
    $root = 'D:\code\.worktrees\'
    if (-not $cand.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw ('job.cwd 不在 ' + $root + ' 下: ' + $cand)
    }
    if (-not (Test-Path -LiteralPath $cand)) { throw ('job.cwd 不存在: ' + $cand) }
    $work = $cand
  }
  $done.cwd = $work

  $bash = 'C:\Program Files\Git\bin\bash.exe'
  if (-not (Test-Path -LiteralPath $bash)) { throw ('没有 bash: ' + $bash) }
  $script = Join-Path $Repo 'ci\headless-task.sh'
  if (-not (Test-Path -LiteralPath $script)) { throw ('缺入口脚本: ' + $script) }
  if (-not (Test-Path -LiteralPath $Install)) { throw ('缺安装目录: ' + $Install) }

  # 环境：只给入口需要的东西。清掉一切可能的凭据来源。
  foreach ($k in @('GIT_TOKEN','GIT_ASKPASS','GIT_SSH_COMMAND','GIT_SSH_VARIANT','GH_TOKEN','GITHUB_TOKEN',
                   'SILICONFLOW_API_KEY','ZHIPU_API_KEY','LEMONADE_HOME_API_KEY','HINDSIGHT_API_TOKEN','DEEPSEEK_API_KEY',
                   'DSH_HEADLESS_ALLOW_CREDS','DSH_HEADLESS_PATCH','DSH_HEADLESS_RESUME','DSH_SESSION_ID')) {
    Remove-Item -LiteralPath ('Env:' + $k) -ErrorAction SilentlyContinue
  }
  $env:DSH_INSTALL = $Install
  # 计划任务环境里 USERPROFILE 正常存在；没有就按 USERNAME 兜底（DSH_HOME 指错会重装 profile）
  $userHome = $env:USERPROFILE
  if ([string]::IsNullOrWhiteSpace($userHome)) { $userHome = Join-Path 'C:\Users' $env:USERNAME }
  $env:DSH_HOME = Join-Path $userHome '.dsh'
  $env:DSH_HEADLESS_JSON = '1'
  $env:DSH_HEADLESS_ALLOW_CREDS = ''
  $env:DSH_HEADLESS_PATCH = ''
  $env:TMP = $env:TEMP

  $taskFile = Join-Path $JobDir 'task.txt'
  $logFile = Join-Path $JobDir 'headless.log'
  $errFile = Join-Path $JobDir 'headless.err'
  [System.IO.File]::WriteAllText($taskFile, $task, $Utf8NoBom)
  if (Test-Path -LiteralPath $logFile) { Remove-Item -LiteralPath $logFile -Force }
  if (Test-Path -LiteralPath $errFile) { Remove-Item -LiteralPath $errFile -Force }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $bash
  $psi.Arguments = ('"{0}" -' -f $script)
  $psi.WorkingDirectory = $work
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  # PS 5.1 的 ProcessStartInfo 没有 StandardInputEncoding（.NET Core 才有），StandardInput 的
  # StreamWriter 用的是 [Console]::InputEncoding —— 本机默认 gb2312，中文任务会变成乱码字节。
  [Console]::InputEncoding = $Utf8NoBom
  $psi.StandardOutputEncoding = $Utf8NoBom
  $psi.StandardErrorEncoding = $Utf8NoBom
  $psi.EnvironmentVariables['DSH_INSTALL'] = $Install
  $psi.EnvironmentVariables['DSH_HOME'] = $env:DSH_HOME
  $psi.EnvironmentVariables['DSH_HEADLESS_JSON'] = '1'
  $psi.EnvironmentVariables['PATH'] = $env:PATH

  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEndAsync()
  $p.StandardInput.Write($task)
  $p.StandardInput.Close()

  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    try { & taskkill.exe /PID $p.Id /T /F | Out-Null } catch { }
    $done.exit = -1
    $done.error = ('超时 ' + $timeoutSec + 's，已强杀进程树')
  } else {
    $done.exit = $p.ExitCode
  }

  $out = $stdout.Result
  $err = $stderr.Result
  if ($null -eq $out) { $out = '' }
  if ($null -eq $err) { $err = '' }
  [System.IO.File]::WriteAllText($logFile, $out, $Utf8NoBom)
  [System.IO.File]::WriteAllText($errFile, $err, $Utf8NoBom)

  $lines = @($out -split "`r?`n")
  $verdictLine = ''
  for ($i = $lines.Count - 1; $i -ge 0 -and $i -ge $lines.Count - 200; $i--) {
    if ($lines[$i] -match 'VERDICT:\s*(PASS|FAIL)') { $verdictLine = $lines[$i]; break }
  }
  $tail = @()
  if ($lines.Count -gt 0) { $tail = @($lines | Select-Object -Last 25) }

  $done.verdict = $verdictLine
  $done.tail = $tail
  $done.ok = ($done.exit -eq 0)
  if (-not $done.ok -and -not $done.error) { $done.error = ('headless exit=' + $done.exit) }
} catch {
  $done.ok = $false
  $done.error = $_.Exception.Message
  try { $done.exit = 2 } catch { }
}

$done.endedAt = (Get-Date).ToString('o')
$done.durationSec = [int]((Get-Date) - $started).TotalSeconds
Write-Done $done
if ($done.ok) { exit 0 } elseif ($done.exit -eq 2) { exit 2 } else { exit 1 }
