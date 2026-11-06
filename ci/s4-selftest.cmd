@echo off
rem ci\s4-selftest.cmd - offline self-check for the S4 low-privilege channel.
rem
rem What it proves (no model call, no credentials, ~10s):
rem   1. every S4 PowerShell script still parses under Windows PowerShell 5.1
rem   2. ci/s4-job.mjs still parses and its exports resolve (import path intact)
rem   3. the job module still refuses a cwd outside D:\code\.worktrees
rem   4. queue/failure/retry semantics hold (ci/s4-concurrency-check.mjs, stub launcher)
rem
rem Not covered: an actual low-privilege headless run (that needs dsh-agent's password
rem and a loaded Lemonade model; run `node ci\s4-job.mjs --task "????????? ok" --cwd
rem D:\code\.worktrees\.s4\sandbox --json` for that).
setlocal
cd /d "%~dp0.."
set "NODE=C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" (
  echo FAIL node missing: %NODE%
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$bad=0; foreach($f in @('ci\s4-install.ps1','ci\s4-run-headless.ps1','ci\s4-as-agent.ps1','ci\s4-fix.ps1','ci\s4-grant-logon.ps1','ci\s4-stub-launcher.ps1')){ $p=Join-Path $PWD $f; $e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$null,[ref]$e); if($e.Count){ $bad++; Write-Host ('FAIL parse ' + $f); $e | ForEach-Object { Write-Host ('  ' + $_.Message) }; continue }; $b=[IO.File]::ReadAllBytes($p); $bom=($b.Length -ge 3 -and $b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191); $nonascii=$false; foreach($x in $b){ if($x -gt 127){ $nonascii=$true; break } }; if(-not $bom -and $nonascii){ $bad++; Write-Host ('FAIL bom missing (PS5.1 reads it as ANSI) ' + $f) } else { Write-Host ('ok   parse+bom ' + $f) } }; exit $bad"
if errorlevel 1 ( echo == FAIL: powershell parse == & exit /b 1 )

"%NODE%" --check ci\s4-job.mjs || ( echo FAIL s4-job.mjs syntax & exit /b 1 )
echo ok   s4-job.mjs syntax

"%NODE%" -e "import('./ci/s4-job.mjs').then(m=>{ if(!m.runAsAgent||!m.prepareJob){ console.error('FAIL exports missing'); process.exit(1);} let threw=false; try{ m.prepareJob({task:'x',cwd:'C:/Windows'}); }catch(e){ threw=true; } if(!threw){ console.error('FAIL cwd guard accepted C:/Windows'); process.exit(1);} console.log('ok   exports + cwd guard'); }).catch(e=>{ console.error('FAIL import: '+e.message); process.exit(1); })" || ( echo == FAIL: module == & exit /b 1 )

echo == 4/4 concurrency ^& failure semantics ==
"%NODE%" ci\s4-concurrency-check.mjs || ( echo == FAIL: concurrency == ^& exit /b 1 )

echo == S4 SELFTEST OK ==
exit /b 0
