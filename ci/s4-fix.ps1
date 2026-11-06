#Requires -RunAsAdministrator
<#
  s4-fix.ps1 - repair the ACL damage left by ci/s4-install.ps1 v1.

  Why: v1 granted BUILTIN\Administrators instead of the interactive account.
  Non-elevated processes (this session, the dispatcher) hold Administrators as a
  deny-only SID, so they lost access to D:\code, .worktrees and the repo.

  What it does:
    1. grants <DOMAIN>\<USER> (OI)(CI)F on D:\code and every subtree that must
       stay reachable without elevation (takes ownership when icacls is denied);
    2. re-asserts the agent-side rights (RX on D:\code, M on .worktrees + job dir);
    3. restores D:\code\.secrets to Administrator/SYSTEM/Administrators only and
       removes any dsh-agent ACE that the /T pass added;
    4. re-registers DSHAgentHeadless and prints the real exception if it fails;
    5. verifies reads from a plain (non-elevated) token does NOT get tested here;
       the script prints icacls state so the next session can compare.

  Run from an elevated PowerShell:
    powershell -NoProfile -ExecutionPolicy Bypass -File ci\s4-fix.ps1
#>
[CmdletBinding()]
param(
  [string]$Repo = 'D:\code\dsh-pipeline-demo',
  [string]$AgentUser = 'dsh-agent',
  [string]$Install = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness',
  [string]$Log = 'D:\code\.worktrees\s4-fix.log',
  [switch]$SkipTask
)

$ErrorActionPreference = 'Continue'
$code = Split-Path -Parent $Repo
$me = "$env:USERDOMAIN\$env:USERNAME"
if ($me -notmatch '\\') { $me = "$env:COMPUTERNAME\$env:USERNAME" }
$logDir = Split-Path -Parent $Log
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date).ToString('HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -Path $Log -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
}

function Icacls([string[]]$a) {
  $out = & icacls.exe @a 2>&1
  return @{ code = $LASTEXITCODE; out = ($out -join ' ') }
}

# grant spec on one path (optionally recursive); take ownership and retry on denial
function Fix([string]$path, [string]$spec, [switch]$Recurse, [switch]$OwnFirst) {
  if (-not (Test-Path -LiteralPath $path)) { Log "  skip (missing): $path"; return $false }
  if ($OwnFirst -or $Recurse) {
    if ($Recurse) { & takeown.exe /F $path /R /D Y 2>&1 | Out-Null } else { & takeown.exe /F $path 2>&1 | Out-Null }
  }
  $arg = @($path, '/grant', $spec)
  if ($Recurse) { $arg += @('/T', '/C', '/Q') }
  $r = Icacls $arg
  if ($r.code -ne 0) {
    Log ("  icacls denied (exit {0}), taking ownership: {1}" -f $r.code, $path)
    if ($Recurse) { & takeown.exe /F $path /R /D Y 2>&1 | Out-Null } else { & takeown.exe /F $path 2>&1 | Out-Null }
    $r = Icacls $arg
  }
  Log ("  [exit {0}] {1} <- {2}" -f $r.code, $path, $spec)
  if ($r.code -ne 0) { Log ("    detail: " + $r.out) }
  return ($r.code -eq 0)
}

Log "== s4-fix =="
Log "account: $me"
Log "repo: $Repo"

Log "-- 1. reachable without elevation --"
[void](Fix $code "$me`:(OI)(CI)F")
[void](Fix "$code\.worktrees" "$me`:(OI)(CI)F")
[void](Fix "$code\.worktrees\.s4" "$me`:(OI)(CI)F")
[void](Fix "$code\.worktrees\.s4\current" "$me`:(OI)(CI)F")
[void](Fix $Repo "$me`:(OI)(CI)F" -Recurse)
[void](Fix "$Repo\.logs" "$me`:(OI)(CI)F" -Recurse)
[void](Fix "$code\vc" "$me`:(OI)(CI)F" -Recurse)
[void](Fix "$code\docs" "$me`:(OI)(CI)F" -Recurse)
foreach ($f in @("$code\AGENTS.md", "$code\voltest-cross.txt")) {
  if (Test-Path -LiteralPath $f) { [void](Fix $f "$me`:(F)") }
}

Log "-- 2. agent rights --"
[void](Fix $code "$AgentUser`:(OI)(CI)(RX)")
[void](Fix "$code\.worktrees" "$AgentUser`:(OI)(CI)(M)")
[void](Fix "$code\.worktrees\.s4\current" "$AgentUser`:(OI)(CI)(M)")
[void](Fix $Repo "$AgentUser`:(OI)(CI)(RX)")
[void](Fix $Install "$AgentUser`:(OI)(CI)(RX)")

Log "-- 3. .secrets back to admin-only --"
$sec = Join-Path $code '.secrets'
$r = Icacls -a @($sec, '/remove:g', "$AgentUser")
Log ("  remove agent: exit {0}" -f $r.code)
[void](Icacls -a @($sec, '/inheritance:r'))
[void](Fix $sec "$me`:(OI)(CI)F")
[void](Fix $sec 'NT AUTHORITY\SYSTEM:(OI)(CI)F')
[void](Fix $sec 'BUILTIN\Administrators:(OI)(CI)F')
Log "  current .secrets ACL:"
(& icacls.exe $sec 2>&1) | ForEach-Object { Log ("    " + $_) }

Log "-- 4. reachability check (as $me) --"
foreach ($p in @("$Repo\.logs", "$code\.worktrees\.s4\current", "$code\vc\_duplicates", "$Repo\.git")) {
  if (-not (Test-Path -LiteralPath $p)) { Log "  missing: $p"; continue }
  try {
    if (Test-Path -LiteralPath $p -PathType Container) {
      $n = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop).Count
      Log ("  ok  {0} ({1} entries)" -f $p, $n)
    } else { Log ("  ok  {0}" -f $p) }
  } catch { Log ("  FAIL {0} : {1}" -f $p, $_.Exception.Message) }
}

if ($SkipTask) { Log "-- 5. task re-register skipped --"; return }

Log "-- 5. re-register DSHAgentHeadless --"
$pwdFile = Join-Path $sec 'dsh-agent.pwd'
if (-not (Test-Path $pwdFile)) { Log "  no password file, cannot register"; return }
$agentPwd = ([IO.File]::ReadAllText($pwdFile)).Trim()
$runner = Join-Path $Repo 'ci\s4-run-headless.ps1'
$jobDir = "$code\.worktrees\.s4\current"
$userFull = "$env:COMPUTERNAME\$AgentUser"
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -JobDir "{1}" -Install "{2}" -Repo "{3}"' -f $runner, $jobDir, $Install, $Repo)
  # 注意：-Principal 与 -User/-Password 不能同时给（参数集互斥）。
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName 'DSHAgentHeadless' -Action $action -Settings $settings -User $userFull -Password $agentPwd -RunLevel Limited -Force -ErrorAction Stop | Out-Null
  Log "  registered OK"
} catch {
  Log ("  REGISTER FAILED: {0}" -f $_.Exception.Message)
  if ($_.Exception.InnerException) { Log ("  inner: " + $_.Exception.InnerException.Message) }
}
$t = Get-ScheduledTask -TaskName 'DSHAgentHeadless' -ErrorAction SilentlyContinue
if ($t) { Log ("  task: runas=" + $t.Principal.UserId + " logon=" + $t.Principal.LogonType + " state=" + $t.State) }
else { Log "  task: NOT FOUND after register" }

Log "== done. log: $Log =="
