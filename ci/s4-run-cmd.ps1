# s4-run-cmd.ps1 - run ONE shell command as the low-privilege user (default dsh-agent).
#
# Contract (job directory):
#   input   <JobDir>\job.json  { "cmd": "bash scripts/verify.sh", "timeoutSec": 900,
#                                "cwd": "C:\ProgramData\dsh-gate\dsh-gate-XXXX" }
#   output  <JobDir>\cmd.log   stdout + stderr of the command
#           <JobDir>\done.json { ok, exit, user, cmd, cwd, startedAt, endedAt, durationSec, tail, error }
#
# Why a separate runner: s4-run-headless.ps1 runs a DSH headless *agent* (stdin = prompt).
# The dispatcher needs the opposite - execute a fixed command whose content it may not trust
# (an issue's ### acceptance command, scripts/verify.sh, tools/pipeline/run.mjs) WITHOUT the
# Administrator token. That is the only way to stop "one labelled issue == Admin command exec".
#
# cwd whitelist is deliberate: a .worktrees issue dir or a candidate tree under
# C:\ProgramData\dsh-gate. Anything else is refused, so a forged job.json cannot aim the
# low-priv user at an arbitrary directory.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$JobDir,
  [string]$Install = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness',
  [string[]]$AllowedCwdRoots = @('D:\code\.worktrees\', 'C:\ProgramData\dsh-gate\')
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
  endedAt = $null; durationSec = 0; cmd = ''; cwd = ''; tail = @(); error = ''
}

if (-not (Test-Path -LiteralPath $JobDir)) { New-Item -ItemType Directory -Path $JobDir -Force | Out-Null }

try {
  $jobFile = Join-Path $JobDir 'job.json'
  if (-not (Test-Path -LiteralPath $jobFile)) { throw ('missing ' + $jobFile) }
  $job = [System.IO.File]::ReadAllText($jobFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $cmd = [string]$job.cmd
  if ([string]::IsNullOrWhiteSpace($cmd)) { throw 'job.json cmd is empty' }
  $done.cmd = $cmd
  $timeoutSec = 900
  if ($job.timeoutSec) { $timeoutSec = [int]$job.timeoutSec }

  $rawCwd = [string]$job.cwd
  if ([string]::IsNullOrWhiteSpace($rawCwd)) { throw 'job.json cwd is empty' }
  # 词法前缀检查挡不住 D:\code\.worktrees\..\..\dsh\default-workspace：先规范化再比较。
  if ($rawCwd -match '\.\.') { throw ('job.cwd contains ..: ' + $rawCwd) }
  $work = [System.IO.Path]::GetFullPath($rawCwd)
  $okRoot = $false
  foreach ($root in $AllowedCwdRoots) {
    $rootFull = [System.IO.Path]::GetFullPath($root)
    if ($work.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) { $okRoot = $true }
  }
  if (-not $okRoot) { throw ('job.cwd is outside allowed roots: ' + $work) }
  if (-not (Test-Path -LiteralPath $work)) { throw ('job.cwd does not exist: ' + $work) }
  $done.cwd = $work

  $bash = 'C:\Program Files\Git\bin\bash.exe'
  if (-not (Test-Path -LiteralPath $bash)) { throw ('no bash: ' + $bash) }

  # The low-priv logon session has no bundled node/pnpm on PATH; verify.sh needs both.
  $bundle = Join-Path $Install 'resources\runtime\primary-runtime\dependencies'
  $nodeBin = Join-Path $bundle 'node\bin'
  if (Test-Path -LiteralPath (Join-Path $nodeBin 'node.exe')) {
    if (($env:PATH -split ';') -notcontains $nodeBin) { $env:PATH = $nodeBin + ';' + $env:PATH }
  }
  if ([string]::IsNullOrWhiteSpace($env:PNPM_CLI)) {
    $pnpmCjs = Join-Path $bundle 'pnpm\bin\pnpm.cjs'
    if (Test-Path -LiteralPath $pnpmCjs) { $env:PNPM_CLI = $pnpmCjs }
  }

  foreach ($k in @('GIT_TOKEN','GIT_ASKPASS','GIT_SSH_COMMAND','GIT_SSH_VARIANT','GH_TOKEN','GITHUB_TOKEN',
                   'SILICONFLOW_API_KEY','ZHIPU_API_KEY','LEMONADE_HOME_API_KEY','HINDSIGHT_API_TOKEN','DEEPSEEK_API_KEY',
                   'DSH_HEADLESS_ALLOW_CREDS','DSH_HEADLESS_PATCH','DSH_HEADLESS_RESUME','DSH_SESSION_ID','DSH_PROXY_TOKEN')) {
    Remove-Item -LiteralPath ('Env:' + $k) -ErrorAction SilentlyContinue
  }
  $env:DSH_INSTALL = $Install
  $userHome = $env:USERPROFILE
  if ([string]::IsNullOrWhiteSpace($userHome)) { $userHome = Join-Path 'C:\Users' $env:USERNAME }
  $env:DSH_HOME = Join-Path $userHome '.dsh'
  $env:DSH_PERMISSION_MODE = 'danger-full-access'
  $env:TMP = $env:TEMP

  $logFile = Join-Path $JobDir 'cmd.log'
  if (Test-Path -LiteralPath $logFile) { Remove-Item -LiteralPath $logFile -Force }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $bash
  # -lc mirrors the dispatcher's run(BASH, ['-lc', cmd]); the command text is data, not a path.
  $psi.Arguments = ('-lc {0}' -f ('"' + ($cmd -replace '"', '\"') + '"'))
  $psi.WorkingDirectory = $work
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $Utf8NoBom
  $psi.StandardErrorEncoding = $Utf8NoBom
  $psi.EnvironmentVariables['DSH_INSTALL'] = $Install
  $psi.EnvironmentVariables['DSH_HOME'] = $env:DSH_HOME
  $psi.EnvironmentVariables['DSH_PERMISSION_MODE'] = $env:DSH_PERMISSION_MODE
  if ($env:PNPM_CLI) { $psi.EnvironmentVariables['PNPM_CLI'] = $env:PNPM_CLI }
  $psi.EnvironmentVariables['PATH'] = $env:PATH

  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  $stdout = $p.StandardOutput.ReadToEndAsync()
  $stderr = $p.StandardError.ReadToEndAsync()

  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    try { & taskkill.exe /PID $p.Id /T /F | Out-Null } catch { }
    $done.exit = -1
    $done.error = ('timeout ' + $timeoutSec + 's, process tree killed')
  } else {
    $done.exit = $p.ExitCode
  }

  $out = $stdout.Result
  $err = $stderr.Result
  if ($null -eq $out) { $out = '' }
  if ($null -eq $err) { $err = '' }
  $all = ($out + "`r`n" + $err)
  [System.IO.File]::WriteAllText($logFile, $all, $Utf8NoBom)

  $lines = @($all -split "`r?`n")
  $tail = @()
  if ($lines.Count -gt 0) { $tail = @($lines | Select-Object -Last 25) }
  $done.tail = $tail
  $done.ok = ($done.exit -eq 0)
  if (-not $done.ok -and -not $done.error) { $done.error = ('exit=' + $done.exit) }
} catch {
  $done.ok = $false
  $done.error = $_.Exception.Message
  try { $done.exit = 2 } catch { }
}

$done.endedAt = (Get-Date).ToString('o')
$done.durationSec = [int]((Get-Date) - $started).TotalSeconds
Write-Done $done
if ($done.ok) { exit 0 } elseif ($done.exit -eq 2) { exit 2 } else { exit 1 }
