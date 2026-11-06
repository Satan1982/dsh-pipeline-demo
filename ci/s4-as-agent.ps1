# s4-as-agent.ps1 - run ci\s4-run-headless.ps1 as the low-privilege user (default dsh-agent).
#
# Why not "schtasks /run /tn DSHAgentHeadless":
#   a non-elevated Administrator token is denied starting a task whose principal is another user
#   (measured 2026-11-06: "ERROR: Access is denied"), and the dispatcher itself runs in exactly
#   that token. CreateProcessWithLogonW (Start-Process -Credential) works there instead, and it
#   also means the child gets the agent's own profile environment - no dispatcher secrets leak in.
#
# PS 5.1 quirks measured the hard way:
#   - -Credential + -RedirectStandardOutput -> Win32Exception "Access is denied" (handles cannot be
#     inherited across the logon session). So the child writes its own files.
#   - -Credential + -PassThru returns $null, so the exit code comes from <JobDir>\done.json instead.
#
# Contract: <JobDir>\job.json is written by the caller (ci/s4-job.mjs). This script launches the
# runner, waits for done.json and exits with the task's exit code (3 = never produced done.json).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$JobDir,
  [string]$SecretsDir = 'D:\code\.secrets',
  [string]$Runner = 'D:\code\dsh-pipeline-demo\ci\s4-run-headless.ps1',
  [string]$AgentUser = 'dsh-agent'
)

$ErrorActionPreference = 'Stop'

# trace: one line per step, so a silent failure is diagnosable without guessing
$traceFile = Join-Path $JobDir 'launcher.trace'
function Trace([string]$m) {
  try {
    [System.IO.File]::AppendAllText($traceFile, ((Get-Date).ToString('o') + ' ' + $m + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}
Trace 'start'

try {
  if (-not (Test-Path -LiteralPath $JobDir)) { New-Item -ItemType Directory -Path $JobDir -Force | Out-Null }

  $pwdFile = Join-Path $SecretsDir ($AgentUser + '.pwd')
  if (-not (Test-Path -LiteralPath $pwdFile)) { throw ('no password file: ' + $pwdFile) }
  if (-not (Test-Path -LiteralPath $Runner)) { throw ('no runner: ' + $Runner) }

  $jobFile = Join-Path $JobDir 'job.json'
  $doneFile = Join-Path $JobDir 'done.json'
  if (-not (Test-Path -LiteralPath $jobFile)) { throw ('no job.json: ' + $jobFile) }
  $job = [System.IO.File]::ReadAllText($jobFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $timeoutSec = 2400
  if ($job.timeoutSec) { $timeoutSec = [int]$job.timeoutSec }
  Trace ('job loaded timeoutSec=' + $timeoutSec)

  $plain = ([System.IO.File]::ReadAllText($pwdFile)).Trim()
  $secure = ConvertTo-SecureString $plain -AsPlainText -Force
  $cred = New-Object System.Management.Automation.PSCredential($AgentUser, $secure)
  Trace 'credential ready'

  # a stale done.json would make the wait return the previous run's result - drop it first
  if (Test-Path -LiteralPath $doneFile) { Remove-Item -LiteralPath $doneFile -Force }
  $argv = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Runner, '-JobDir', $JobDir)
  Start-Process -FilePath 'powershell.exe' -Credential $cred -WindowStyle Hidden -ArgumentList $argv | Out-Null
  Trace 'runner launched'

  # the runner enforces the timeout and kills its process tree; give it 3 extra minutes
  $deadline = (Get-Date).AddSeconds($timeoutSec + 180)
  while (-not (Test-Path -LiteralPath $doneFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
  if (-not (Test-Path -LiteralPath $doneFile)) { Trace 'timeout, no done.json'; exit 3 }
  Trace 'done.json appeared'

  $done = [System.IO.File]::ReadAllText($doneFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($null -eq $done.exit) { Trace 'done.exit is null'; exit 1 }
  Trace ('done.exit=' + $done.exit)
  exit ([int]$done.exit)
} catch {
  Trace ('ERROR ' + $_.Exception.Message)
  exit 2
}
