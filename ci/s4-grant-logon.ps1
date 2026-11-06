#Requires -RunAsAdministrator
<#
  s4-grant-logon.ps1 - finish S4 verification when the low-privilege task refuses to start.

  Symptom it addresses: DSHAgentProbe stays in state Ready, never runs, no
  dsh-agent process appears, and no probe.json is written. Task Scheduler needs
  "Log on as a batch job" (SeBatchLogonRight) for a task that stores a password
  and runs whether or not the user is logged on; dsh-agent was created without it.

  What it does (idempotent):
    1. adds SeBatchLogonRight for the agent account to the local security policy;
    2. re-registers DSHAgentProbe (password from .secrets\dsh-agent.pwd);
    3. starts it, waits for probe.json, prints every check;
    4. prints LastTaskResult so a remaining failure is diagnosable;
    5. removes the probe task again.

  Run from an elevated PowerShell:
    powershell -NoProfile -ExecutionPolicy Bypass -File ci\s4-grant-logon.ps1
#>
[CmdletBinding()]
param(
  [string]$AgentUser = 'dsh-agent',
  [string]$Repo = 'D:\code\dsh-pipeline-demo',
  [string]$AgentHome = 'C:\Users\dsh-agent',
  [string]$ProbeOut = 'D:\code\.worktrees\.s4\probe.json'
)

$ErrorActionPreference = 'Continue'
$log = 'D:\code\.worktrees\s4-grant-logon.log'
function Log([string]$m) {
  $line = '{0} {1}' -f (Get-Date).ToString('HH:mm:ss'), $m
  Write-Host $line
  try { Add-Content -Path $log -Value $line -Encoding UTF8 -ErrorAction Stop } catch { }
}

$me = "$env:USERDOMAIN\$env:USERNAME"
$sid = (New-Object System.Security.Principal.NTAccount($AgentUser)).Translate([System.Security.Principal.SecurityIdentifier]).Value
Log "== s4-grant-logon =="
Log "user: $AgentUser  sid: $sid"

$key = 'SeBatchLogonRight'
$cfg = Join-Path $env:TEMP 's4-secedit-userrights.inf'
$db = Join-Path $env:TEMP 's4-secedit.sdb'
[void](& secedit.exe /export /cfg $cfg /areas USER_RIGHTS 2>&1)
if (-not (Test-Path -LiteralPath $cfg)) { Log 'secedit export failed'; exit 1 }

$lines = [System.IO.File]::ReadAllLines($cfg)
$hit = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i].TrimStart().StartsWith($key)) {
    if ($lines[$i] -notmatch [regex]::Escape("*$sid")) {
      $lines[$i] = ($lines[$i].TrimEnd() + ",*$sid")
      Log "  append *$sid to $key"
    } else { Log "  $key already contains *$sid" }
  }
}
[System.IO.File]::WriteAllLines($cfg, $lines, [System.Text.Encoding]::Unicode)
$cur = [System.IO.File]::ReadAllLines($cfg) | Where-Object { $_ -match $key }
Log ("  policy line: " + ($cur -join ''))
if (($cur -join '') -notmatch [regex]::Escape("*$sid")) { Log '  policy line still missing the sid - abort'; exit 1 }

[void](& secedit.exe /configure /db $db /cfg $cfg /areas USER_RIGHTS 2>&1)
Log ("  secedit /configure exit=" + $LASTEXITCODE)

$pwdFile = 'D:\code\.secrets\dsh-agent.pwd'
if (-not (Test-Path $pwdFile)) { Log 'no password file'; exit 1 }
$pwd = ([System.IO.File]::ReadAllText($pwdFile)).Trim()
$userFull = "$env:COMPUTERNAME\$AgentUser"
$probe = Join-Path $Repo 'ci\s4-probe.ps1'
$pargs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Out "{1}" -SkipEntry' -f $probe, $ProbeOut

Log '-- register DSHAgentProbe --'
if (Test-Path -LiteralPath $ProbeOut) { Remove-Item -LiteralPath $ProbeOut -Force }
try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $pargs
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  Register-ScheduledTask -TaskName 'DSHAgentProbe' -Action $action -Settings $settings -User $userFull -Password $pwd -RunLevel Limited -Force -ErrorAction Stop | Out-Null
  Log '  registered'
  Start-ScheduledTask -TaskName 'DSHAgentProbe'
  Log '  started'
} catch {
  Log ('  REGISTER/START FAILED: ' + $_.Exception.Message)
  exit 1
}

$deadline = (Get-Date).AddMinutes(3)
while (-not (Test-Path -LiteralPath $ProbeOut) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
Start-Sleep -Seconds 1
$info = $null
try { $info = Get-ScheduledTaskInfo -TaskName 'DSHAgentProbe' } catch { }
if ($info) { Log ('  LastRunTime=' + $info.LastRunTime + ' LastTaskResult=' + $info.LastTaskResult) }

if (-not (Test-Path -LiteralPath $ProbeOut)) {
  Log '  no probe.json - task still did not produce output'
} else {
  $doc = [System.IO.File]::ReadAllText($ProbeOut, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  Log ('  probe ran as: ' + $doc.user)
  foreach ($c in $doc.checks) {
    Log ('    {0,-18} expect {1,-5} {2}  {3}' -f $c.id, $c.expected, $(if ($c.pass) { 'PASS' } else { 'FAIL' }), $c.detail)
  }
  Log ('  allPass=' + $doc.allPass + ' failed=' + (@($doc.failed) -join ','))
}
Unregister-ScheduledTask -TaskName 'DSHAgentProbe' -Confirm:$false -ErrorAction SilentlyContinue
Log '== done =='
