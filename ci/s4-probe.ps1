# s4-probe.ps1 — S4 隔离自检。必须由「低权用户」执行才有意义（计划任务 DSHAgentProbe）。
#
# 每条检查都写「期望 / 实际 / 判定」，结果落 JSON 给管理员侧读：
#   powershell -NoProfile -File ci\s4-probe.ps1 -Out D:\code\.worktrees\.s4\probe.json
# 加上 -SkipEntry:$false 会顺带起一次真实 headless（本地大模型档已停用，未给
# DSH_HEADLESS_PATCH 时入口会 fail-closed；只在确实配好云端路由时才试）。
#
# 注意：以管理员身份跑会得到一堆 FAIL（那正是期望的反面），不要拿它当「隔离没过」。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Install = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness',
  [string]$Repo = 'D:\code\dsh-pipeline-demo',
  [string]$AgentUser = 'dsh-agent',
  [switch]$SkipEntry = $true
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$checks = New-Object System.Collections.ArrayList

function Add-Check([string]$Id, [string]$Expected, [bool]$Pass, [string]$Detail) {
  [void]$checks.Add([ordered]@{
    id = $Id; expected = $Expected; actual = $(if ($Pass) { $Expected } else { '不匹配' })
    pass = $Pass; detail = $Detail
  })
}

function Try-ExpectFail([string]$Id, [string]$What, [scriptblock]$Body) {
  $ok = $false; $detail = ''
  try {
    $null = & $Body
    $ok = $false
    # 故意不回显返回值：这条检查可能读到凭据本身，任何内容都不许进日志/JSON。
    $detail = '成功了（=不设防）：预期被拒绝却通过了'
  } catch {
    $ok = $true
    $msg = $_.Exception.Message -replace "`r|`n", ' '
    if ($msg.Length -gt 90) { $msg = $msg.Substring(0, 90) + '…' }
    $detail = ('被拒绝：' + $msg)
  }
  Add-Check $Id 'deny' $ok ($What + ' → ' + $detail)
}

function Try-ExpectAllow([string]$Id, [string]$What, [scriptblock]$Body) {
  try {
    $r = & $Body
    Add-Check $Id 'allow' $true ($What + ' → ' + [string]$r)
  } catch {
    $msg = $_.Exception.Message -replace "`r|`n", ' '
    Add-Check $Id 'allow' $false ($What + ' → 失败：' + $msg)
  }
}

# 1 身份
$who = @($env:USERNAME, $env:USERDOMAIN) -join '\'
Add-Check 'user' $AgentUser ($env:USERNAME -eq $AgentUser) ('whoami=' + $who)

# 2 读 .secrets 必须失败
Try-ExpectFail 'read-secrets-token' '读 .secrets\github-token.txt' {
  [System.IO.File]::ReadAllText('D:\code\.secrets\github-token.txt')
}
Try-ExpectFail 'list-secrets' '列 .secrets 目录' {
  @(Get-ChildItem -LiteralPath 'D:\code\.secrets' -ErrorAction Stop).Count
}

# 3 写管理员 home 必须失败
$adminProbe = 'C:\Users\Administrator\.dsh\s4-probe-' + [guid]::NewGuid().ToString('N') + '.txt'
Try-ExpectFail 'write-admin-dsh' '写 C:\Users\Administrator\.dsh' {
  [System.IO.File]::WriteAllText($adminProbe, 'probe')
}

# 4 改仓库代码必须失败（否则低权进程能改 ci/*.mjs，管理员会执行它们）
$repoProbe = Join-Path $Repo ('ci\s4-probe-' + [guid]::NewGuid().ToString('N') + '.txt')
Try-ExpectFail 'write-repo' ('写 ' + $Repo + '\ci') {
  [System.IO.File]::WriteAllText($repoProbe, 'probe')
}

# 5 读安装目录必须成功（入口要从这里起 Electron）
Try-ExpectAllow 'read-install' '读安装目录' {
  $asar = Join-Path $Install 'resources\app.asar'
  [System.IO.File]::Exists($asar)
}

# 6 写 worktree 必须成功（agent 要改代码）
$wtProbe = 'D:\code\.worktrees\.s4\probe-' + [guid]::NewGuid().ToString('N') + '.txt'
Try-ExpectAllow 'write-worktree' '写 .worktrees\.s4' {
  [System.IO.Directory]::CreateDirectory('D:\code\.worktrees\.s4') | Out-Null
  [System.IO.File]::WriteAllText($wtProbe, 'probe')
  $n = (Get-Item -LiteralPath $wtProbe).Length
  Remove-Item -LiteralPath $wtProbe -Force
  $n
}

# 7 环境里没有凭据
$leaked = @()
foreach ($k in @('GIT_TOKEN','GIT_ASKPASS','GIT_SSH_COMMAND','GH_TOKEN','GITHUB_TOKEN','SILICONFLOW_API_KEY','ZHIPU_API_KEY','DEEPSEEK_API_KEY','HINDSIGHT_API_TOKEN')) {
  if ([System.Environment]::GetEnvironmentVariable($k)) { $leaked += $k }
}
Add-Check 'env-no-creds' 'clean' ($leaked.Count -eq 0) ('泄漏变量: ' + $(if ($leaked.Count) { $leaked -join ',' } else { '无' }))

# 8 入口能起来（可选，慢）
if (-not $SkipEntry) {
  $bash = 'C:\Program Files\Git\bin\bash.exe'
  $script = Join-Path $Repo 'ci\headless-task.sh'
  if (-not (Test-Path -LiteralPath $bash)) {
    Add-Check 'entry' 'allow' $false ('没有 bash: ' + $bash)
  } else {
    $entryOut = Join-Path ([System.IO.Path]::GetDirectoryName($Out)) 'entry.log'
    try {
      $env:DSH_INSTALL = $Install
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $bash
      $psi.Arguments = ('"{0}" -' -f $script)
      $psi.WorkingDirectory = $Repo
      $psi.UseShellExecute = $false
      $psi.RedirectStandardInput = $true
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.EnvironmentVariables['DSH_INSTALL'] = $Install
      $psi.EnvironmentVariables['PATH'] = $env:PATH
      $p = New-Object System.Diagnostics.Process
      $p.StartInfo = $psi
      [void]$p.Start()
      $p.StandardInput.Write('只回复 ok 两个字母，不要做任何别的事。')
      $p.StandardInput.Close()
      $text = $p.StandardOutput.ReadToEnd()
      [void]$p.WaitForExit(600000)
      [System.IO.File]::WriteAllText($entryOut, $text, $Utf8NoBom)
      Add-Check 'entry' 'allow' ($p.ExitCode -eq 0) ('exit=' + $p.ExitCode + ' stdout=' + $text.Length + ' bytes → ' + $entryOut)
    } catch {
      Add-Check 'entry' 'allow' $false ('启动失败：' + $_.Exception.Message)
    }
  }
}

$failed = @($checks | Where-Object { -not $_.pass } | ForEach-Object { $_.id })
$doc = [ordered]@{
  user = $who; agentUser = $AgentUser; time = (Get-Date).ToString('o')
  checks = $checks; failed = $failed; allPass = ($failed.Count -eq 0)
}
$dir = [System.IO.Path]::GetDirectoryName($Out)
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
[System.IO.File]::WriteAllText($Out, ($doc | ConvertTo-Json -Depth 5), $Utf8NoBom)

Write-Host ('probe user=' + $who + ' allPass=' + $doc.allPass)
if ($doc.allPass) { exit 0 } else { exit 1 }
