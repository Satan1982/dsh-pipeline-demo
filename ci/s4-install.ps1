# s4-install.ps1 — S4 低权用户隔离：一键安装 / 验收（需管理员）
#
# 方案全文: D:\dsh\default-workspace\docs\77-S4低权用户隔离方案-20261106.md
#
# 做四件事（都可重复执行，已做的 SKIP）:
#   1. 建本机低权用户 dsh-agent（随机密码存 .secrets\dsh-agent.pwd；.secrets 已是 admin-only）
#   2. 种它的 DSH_HOME（profiles/headless 就 4 个小文件，bundle 从安装目录读，不需要 pnpm install）
#   3. 收紧 ACL（D:\code 去掉 Authenticated Users 的 Modify；.worktrees 给 agent 写；安装目录给读）
#   4. 注册低权 headless 计划任务 DSHAgentHeadless
#
# 明确不做：调度器进程仍以 Administrator 跑。ci/dispatch.mjs:62-79 在模块顶层就从 .secrets
# 读 token / askpass / ssh 包装，把调度器降到低权它自己就连不上 GitHub。降权只发生在
# headless 子进程（ci/dispatch.mjs:1864），这是下一个垂直切片。
#
# 用法:
#   powershell -NoProfile -File ci\s4-install.ps1 -WhatIf     # 只打印，不改系统
#   powershell -NoProfile -File ci\s4-install.ps1             # 真装
#   powershell -NoProfile -File ci\s4-install.ps1 -Verify     # 装完验收（隔离自检在低权上下文跑）
#   powershell -NoProfile -File ci\s4-install.ps1 -Verify -VerifyEntry   # 连入口一起验（慢，不花钱）
#
# 回滚:
#   net user dsh-agent /delete
#   icacls "D:\code" /restore "<.secrets\acl-D-code-*.txt>"
#   Unregister-ScheduledTask -TaskName DSHAgentHeadless -Confirm:$false

[CmdletBinding()]
param(
  [string]$AgentUser = 'dsh-agent',
  [string]$Repo = 'D:\code\dsh-pipeline-demo',
  [string]$Install = 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness',
  [string]$AdminHome = 'C:\Users\Administrator',
  [ValidateSet('Password', 'S4U')]
  [string]$LogonType = 'Password',
  [switch]$WhatIf,
  [switch]$Verify,
  # 只跑注册与验收、跳过 ACL 递归：以 SYSTEM 递归 D:\harness-home 要 8 分钟以上，
  # broker 超时会把 Register-ScheduledTask -Force 杀成「任务消失」。
  [switch]$SkipAcl,
  [switch]$VerifyEntry
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ICACLS = Join-Path $env:SystemRoot 'System32\icacls.exe'
$SecretsDir = 'D:\code\.secrets'
$TaskName = 'DSHAgentHeadless'
$ProbeTaskName = 'DSHAgentProbe'
$JobRoot = 'D:\code\.worktrees\.s4'

$script:stepNo = 0
$script:fails = New-Object System.Collections.ArrayList

function Say([string]$m) { Write-Host $m }
function Step([string]$t) {
  $script:stepNo++
  Write-Host ''
  Write-Host ("[{0}] {1}" -f $script:stepNo, $t) -ForegroundColor Cyan
}
function Ok([string]$m) { Write-Host ("    OK   " + $m) -ForegroundColor Green }
function Skip([string]$m) { Write-Host ("    SKIP " + $m) -ForegroundColor DarkGray }
function Warn([string]$m) { Write-Host ("    WARN " + $m) -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host ("    FAIL " + $m) -ForegroundColor Red; [void]$script:fails.Add($m) }
function Doing([string]$m) {
  if ($WhatIf) { Write-Host ("    DRY  " + $m) -ForegroundColor Yellow }
  else { Write-Host ("    DO   " + $m) }
}

function Is-Admin {
  $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object System.Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-SidOf([string]$Name) {
  try {
    $o = New-Object System.Security.Principal.NTAccount($Name)
    return $o.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch { return $null }
}

function Get-AceSidValue($Ace) {
  try { return $Ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $null }
}

function Test-AceAllow([string]$Path, [string]$SidValue, [string]$RightsPattern) {
  if (-not $SidValue) { return $false }
  try { $aces = (Get-Acl -LiteralPath $Path).Access } catch { return $false }
  foreach ($a in $aces) {
    if ($a.AccessControlType -ne 'Allow') { continue }
    if ((Get-AceSidValue $a) -ne $SidValue) { continue }
    if (-not $RightsPattern) { return $true }
    if (($a.FileSystemRights.ToString()) -match $RightsPattern) { return $true }
  }
  return $false
}

function Get-BroadAces([string]$Path) {
  # 对本机其它用户开放（Allow）的 ACE：Users / Authenticated Users / Everyone / INTERACTIVE
  $bad = New-Object System.Collections.ArrayList
  try { $aces = (Get-Acl -LiteralPath $Path).Access } catch { return $bad }
  foreach ($a in $aces) {
    if ($a.AccessControlType -ne 'Allow') { continue }
    $n = $a.IdentityReference.Value
    if ($n -match '(^|\\)(BUILTIN\\)?(Users|Authenticated Users|Everyone|INTERACTIVE)$') { [void]$bad.Add($n) }
  }
  return $bad
}

function Run-Icacls([string[]]$Argv) {
  $shown = 'icacls ' + (($Argv | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  if ($WhatIf) { Doing $shown; return 0 }
  Write-Host ("    DO   " + $shown) -ForegroundColor DarkGray
  # 原生 stderr 在 $ErrorActionPreference='Stop' 下会被当成终止错误：icacls 递归时遇到超长路径
  # 只对那个文件报错（/C 继续），但脚本会因此整段退出。这里局部用 Continue，成败只看退出码。
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $ICACLS @Argv 2>&1 } finally { $ErrorActionPreference = $prev }
  $code = $LASTEXITCODE
  if ($code -ne 0) { Write-Host (($out | Out-String).Trim()) -ForegroundColor DarkRed }
  return $code
}

# ─────────────────────────────────────────────────────────────────────────────
Say '==== S4 低权用户隔离安装器 ===='
Say ("仓库:     " + $Repo)
Say ("安装:     " + $Install)
Say ("低权用户: " + $AgentUser + "   登录方式: " + $LogonType)
if ($WhatIf) { Say '模式: -WhatIf（只打印，不改系统）' }

$isAdmin = Is-Admin
if (-not $isAdmin -and -not $WhatIf) {
  Say ''
  Say '需要管理员权限：请在「以管理员身份运行」的 PowerShell 里执行本脚本。' -ForegroundColor Red
  exit 2
}
if (-not $isAdmin) { Warn '当前不是管理员：-WhatIf 可读当前状态做预览，但所有 DO 行都不会执行' }

# ── 1 预检 ──────────────────────────────────────────────────────────────────
Step '预检：路径与现状'
foreach ($p in @($Repo, $Install, "$Repo\ci\headless-task.sh", "$Repo\ci\s4-run-headless.ps1", "$Repo\ci\s4-probe.ps1", 'C:\Program Files\Git\bin\bash.exe')) {
  if (Test-Path -LiteralPath $p) { Ok ([string]$p) } else { Fail ('缺: ' + $p) }
}
foreach ($f in @('cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml')) {
  $p = Join-Path $AdminHome ('.dsh\profiles\headless\' + $f)
  if (Test-Path -LiteralPath $p) { Ok ('profile 源: ' + $p) } else { Fail ('缺 profile 源: ' + $p) }
}

$broad = Get-BroadAces $SecretsDir
if ($broad.Count -eq 0) {
  Ok '.secrets 没有对 Users/Authenticated Users 开放的 ACE（D2 的凭据收紧本来就成立）'
} else {
  Fail ('.secrets 对 ' + ($broad -join ', ') + ' 开放 —— 先收紧再装，否则 S4 是假的')
}

if (Test-Path -LiteralPath 'D:\code\.worktrees\.secrets') {
  $item = Get-Item -LiteralPath 'D:\code\.worktrees\.secrets' -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    Warn '.worktrees\.secrets 是指向 .secrets 的 junction：目标 ACL 已拒绝 Users，保留即可（别删，可能有脚本用）'
  }
}

# ── 2 建低权用户 ────────────────────────────────────────────────────────────
Step '建低权用户'
$agentHome = Join-Path 'C:\Users' $AgentUser
$pwdFile = Join-Path $SecretsDir ($AgentUser + '.pwd')
$user = Get-LocalUser -Name $AgentUser -ErrorAction SilentlyContinue
$password = $null
$sid = $null

if ($user) {
  Skip ($AgentUser + ' 已存在')
  $sid = $user.SID.Value
  if (Test-Path -LiteralPath $pwdFile) {
    $password = [System.IO.File]::ReadAllText($pwdFile, [System.Text.Encoding]::UTF8).Trim()
  } elseif ($LogonType -eq 'Password') {
    Fail ('用户已存在但没找到密码文件 ' + $pwdFile + '；删掉用户重装，或改用 -LogonType S4U')
  }
} else {
  $sid = Get-SidOf $AgentUser
  if ($WhatIf) {
    Doing ('New-LocalUser ' + $AgentUser + '（随机密码 → ' + $pwdFile + '，sid=' + $(if ($sid) { $sid } else { '待定' }) + '）')
  } else {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^*-_=+'
    $rnd = New-Object System.Random
    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt 28; $i++) { [void]$sb.Append($chars[$rnd.Next($chars.Length)]) }
    $password = $sb.ToString()
    New-LocalUser -Name $AgentUser -Password (ConvertTo-SecureString $password -AsPlainText -Force) `
      -PasswordNeverExpires -AccountNeverExpires `
      -Description 'DSH 低权 agent 账户（S4 隔离，只给计划任务用）' | Out-Null
    if (-not (Test-Path -LiteralPath $SecretsDir)) { New-Item -ItemType Directory -Path $SecretsDir -Force | Out-Null }
    [System.IO.File]::WriteAllText($pwdFile, $password, $Utf8NoBom)
    $sid = (Get-LocalUser -Name $AgentUser).SID.Value
    Ok ('用户已建，密码落在 ' + $pwdFile + '（目录 .secrets 已是 admin-only）')
  }
}

if (-not $WhatIf) {
  try {
    $admins = @(Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    if (@($admins | Where-Object { $_ -match ([regex]::Escape($AgentUser) + '$') }).Count -gt 0) {
      Fail '被加进了 Administrators —— 必须移除，否则不是低权'
    } else { Ok '不在 Administrators' }
    $users = @(Get-LocalGroupMember -Group 'Users' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    if (@($users | Where-Object { $_ -match ([regex]::Escape($AgentUser) + '$') }).Count -gt 0) { Ok '在 Users 组' } else { Warn '不在 Users 组：任务可能起不来' }
  } catch { Warn ('读本地组失败：' + $_.Exception.Message) }
}

# ── 3 种 DSH_HOME ──────────────────────────────────────────────────────────
Step '种低权用户的 DSH_HOME'
$agentDsh = Join-Path $agentHome '.dsh'
$srcHeadless = Join-Path $AdminHome '.dsh\profiles\headless'
$dstHeadless = Join-Path $agentDsh 'profiles\headless'
Doing ('复制 profiles\headless → ' + $dstHeadless + '；并给 ' + $AgentUser + ' 自己 home 全权')
if (-not $WhatIf) {
  New-Item -ItemType Directory -Path $dstHeadless -Force | Out-Null
  Copy-Item -Path (Join-Path $srcHeadless '*') -Destination $dstHeadless -Force
  $missing = @()
  foreach ($f in @('cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $dstHeadless $f))) { $missing += $f }
  }
  if ($missing.Count -eq 0) { Ok 'seed 4 个文件齐' } else { Fail ('seed 缺: ' + ($missing -join ', ')) }
  [void](Run-Icacls @($agentHome, '/grant', ($AgentUser + ':(OI)(CI)F'), '/T', '/C', '/Q'))
}

# ── 4 收紧 ACL ─────────────────────────────────────────────────────────────
if ($SkipAcl) {
  Say '跳过 ACL 收紧（-SkipAcl，复用当前 ACL）'
} else {
Step '收紧 ACL'

# 4a 安装目录：C:\Users\Administrator 默认没有 Users ACE，低权用户连安装目录都穿不透。
Doing ('授予 ' + $AgentUser + ' 穿越 ' + $AdminHome + '（X）与安装目录读执行（RX，递归 1GB，1-3 分钟）')
if (-not $WhatIf) {
  [void](Run-Icacls @($AdminHome, '/grant', ($AgentUser + ':(X)')))
  $c = Run-Icacls @($Install, '/grant', ($AgentUser + ':(OI)(CI)RX'), '/T', '/C', '/Q')
  if ($c -eq 0) { Ok '安装目录已授读' } else { Fail ('安装目录授权失败 exit=' + $c) }
  if (Test-AceAllow $Install $sid 'Read') { Ok '回读：agent 对安装目录可读' } else { Fail '回读：agent 仍读不到安装目录' }
}

# 4a2 node 解析安装目录要 realpath 穿过 AppData：只给 X 不够，lstat 要 READ_ATTRIBUTES。
#     缺这一步低权进程会报 `EPERM: operation not permitted, lstat 'C:\Users\Administrator\AppData'`。
Doing ('授予 ' + $AgentUser + ' 穿越 AppData 链（RX）')
if (-not $WhatIf) {
  $appData = Join-Path $AdminHome 'AppData'
  foreach ($p in @($appData, (Join-Path $appData 'Local'), (Join-Path $appData 'Local\Programs'))) {
    if (Test-Path -LiteralPath $p) {
      [void](Run-Icacls @($p, '/grant', ($AgentUser + ':(RX)')))
    }
  }
  if (Test-AceAllow (Join-Path $appData 'Local\Programs') $sid 'Read') { Ok '回读：agent 可穿过 AppData\Local\Programs' } else { Fail '回读：agent 穿不过 AppData\Local\Programs' }
}

# 4b 仓库：D:\ 根给 Authenticated Users 的 Modify 会继承到 D:\code，
#     低权进程就能改 ci/*.mjs / src/* —— 而管理员侧调度器会执行 ci/*.mjs（提权面）。
$aclBackup = Join-Path $SecretsDir ('acl-D-code-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.txt')
Doing ('备份 D:\code 的 ACL → ' + $aclBackup)
$haveBackup = $false
if (-not $WhatIf) {
  $c = Run-Icacls @('D:\code\*', '/save', $aclBackup, '/T', '/C', '/Q')
  if ($c -eq 0 -and (Test-Path -LiteralPath $aclBackup)) { $haveBackup = $true; Ok '已备份' }
  else { Fail ('ACL 备份失败 exit=' + $c + '：不做后续变更（改坏了没得恢复）') }
} else { Doing '（WhatIf 不备份）' }

$adminSid = Get-SidOf 'BUILTIN\Administrators'
$sysSid = Get-SidOf 'NT AUTHORITY\SYSTEM'
# 交互账户。非提权进程的令牌里 BUILTIN\Administrators 是 deny-only SID：
# 只给它授权等于没授权，本会话与调度器都会立刻失去 D:\code 的访问（v1 真实事故）。
# 当前身份要用 WindowsIdentity 取：以 SYSTEM（broker/计划任务）运行时 $env:USERNAME 是机器账户
# "ZHAO$"，拼出来的 WORKGROUP\ZHAO$ 没有 SID 映射，icacls /grant 会直接报「账户名与安全标识间无任何映射」。
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($me) -or $me -notmatch '\\') { $me = "$env:USERDOMAIN\$env:USERNAME" }

if ($haveBackup -or $WhatIf) {
  # 顺序很重要：先把管理员/SYSTEM 显式写进去，再 /inheritance:r，
  # 否则去掉继承 ACE 的那一瞬间可能把自己也锁在外面。
  Doing 'D:\code: Administrators/SYSTEM 全控 + agent 只读；去掉 Authenticated Users 的 Modify'
  if (-not $WhatIf) {
    [void](Run-Icacls @('D:\code', '/grant', 'BUILTIN\Administrators:(OI)(CI)F'))
    [void](Run-Icacls @('D:\code', '/grant', ($me + ':(OI)(CI)F')))
    [void](Run-Icacls @('D:\code', '/grant', 'NT AUTHORITY\SYSTEM:(OI)(CI)F'))
    [void](Run-Icacls @('D:\code', '/inheritance:r'))
    [void](Run-Icacls @('D:\code', '/remove:g', 'NT AUTHORITY\Authenticated Users', 'Everyone', 'BUILTIN\Users'))
    [void](Run-Icacls @('D:\code', '/grant', ($AgentUser + ':(OI)(CI)RX')))
    [void](Run-Icacls @('D:\code\.worktrees', '/grant', ($AgentUser + ':(OI)(CI)M')))
    New-Item -ItemType Directory -Path $JobRoot -Force | Out-Null
    [void](Run-Icacls @($JobRoot, '/grant', ($AgentUser + ':(OI)(CI)M')))

    # 回读验证；管理员自己丢权是最坏情况，直接自动恢复
    $adminOk = Test-AceAllow 'D:\code' $adminSid 'FullControl'
    if (-not $adminOk) {
      Fail '管理员对 D:\code 已丢权 —— 自动恢复备份'
      [void](Run-Icacls @('D:\code', '/restore', $aclBackup))
    } else { Ok '管理员仍有完全控制' }
    $broad2 = Get-BroadAces 'D:\code'
    if ($broad2.Count -eq 0) { Ok 'D:\code 不再对其它本机用户开放' } else { Fail ('D:\code 仍对 ' + ($broad2 -join ', ') + ' 开放') }
    if (Test-AceAllow 'D:\code' $sid 'Read') { Ok 'agent 对 D:\code 可读（多目录读写靠 worktree）' } else { Fail 'agent 对 D:\code 不可读' }
    if (Test-AceAllow 'D:\code\.worktrees' $sid 'Modify|Write|FullControl') { Ok 'agent 可写 .worktrees' } else { Fail 'agent 不可写 .worktrees' }
    # 继承变更要传播到子目录才算真收紧：抽查四个关键子目录，有残留就地 /T 修一次再复核。
    $children = @('D:\code\dsh-pipeline-demo', 'D:\code\dsh-pipeline-demo\ci', 'D:\code\vc', 'D:\code\.worktrees')
    $stale = @()
    foreach ($c in $children) { if ((Test-Path -LiteralPath $c) -and (Get-BroadAces $c).Count -gt 0) { $stale += $c } }
    if ($stale.Count -gt 0) {
      Warn ('子目录仍有宽 ACE，跑一次 /T 修正：' + ($stale -join ', '))
      [void](Run-Icacls @('D:\code', '/remove:g', 'NT AUTHORITY\Authenticated Users', 'Everyone', 'BUILTIN\Users', '/T', '/C', '/Q'))
      # 不对 D:\code 根做 /T grant：那会把 agent 的 RX 带进 .secrets（v1 的真实事故）。
      foreach ($sub in @('D:\code\dsh-pipeline-demo', 'D:\code\vc', 'D:\code\docs', 'D:\code\.worktrees')) {
        if (Test-Path -LiteralPath $sub) { [void](Run-Icacls @($sub, '/grant', ($AgentUser + ':(OI)(CI)RX'), '/T', '/C', '/Q')) }
      }
      [void](Run-Icacls @('D:\code\.worktrees', '/grant', ($AgentUser + ':(OI)(CI)M'), '/T', '/C', '/Q'))
      $stale = @()
      foreach ($c in $children) { if ((Test-Path -LiteralPath $c) -and (Get-BroadAces $c).Count -gt 0) { $stale += $c } }
    }
    if ($stale.Count -eq 0) { Ok '子目录抽查：没有残留的宽 ACE' } else { Fail ('子目录仍开放：' + ($stale -join ', ')) }

    # 交互账户：每条需要非提权访问的路径都显式给一遍；icacls 被拒时先 takeown 再给。
    foreach ($p in @('D:\code\.worktrees', 'D:\code\.worktrees\.s4', 'D:\code\dsh-pipeline-demo', 'D:\code\dsh-pipeline-demo\.logs', 'D:\code\vc', 'D:\code\docs')) {
      if (-not (Test-Path -LiteralPath $p)) { continue }
      $rc = Run-Icacls @($p, '/grant', ($me + ':(OI)(CI)F'), '/T', '/C', '/Q')
      if ($rc -ne 0) {
        [void](& takeown.exe /F $p /R /D Y 2>&1 | Out-Null)
        [void](Run-Icacls @($p, '/grant', ($me + ':(OI)(CI)F'), '/T', '/C', '/Q'))
      }
    }
    # .secrets 兜底：任何 /T 带进来的 agent ACE 都收回，回到 Administrator/SYSTEM/Administrators。
    [void](Run-Icacls @($SecretsDir, '/remove:g', $AgentUser, '/T', '/C', '/Q'))
    [void](Run-Icacls @($SecretsDir, '/inheritance:r'))
    [void](Run-Icacls @($SecretsDir, '/grant', ($me + ':(OI)(CI)F')))
    [void](Run-Icacls @($SecretsDir, '/grant', 'NT AUTHORITY\SYSTEM:(OI)(CI)F'))
    [void](Run-Icacls @($SecretsDir, '/grant', 'BUILTIN\Administrators:(OI)(CI)F'))
    $secAcl = (& icacls.exe $SecretsDir 2>&1) -join "`n"
    if ($secAcl -match [regex]::Escape($AgentUser)) { Fail '.secrets 仍含 agent ACE' } else { Ok '.secrets 未给 agent 任何权限' }
    $sec2 = Get-BroadAces $SecretsDir
    if ($sec2.Count -eq 0) { Ok '.secrets 仍然只给管理员/SYSTEM（改动没有波及）' } else { Fail ('.secrets 被波及：对 ' + ($sec2 -join ', ') + ' 开放') }
  }
}

# 4c 管理员自己的 DSH home：C:\Users\Administrator\.dsh 是指向 D:\harness-home 的 junction，
#    D:\ 根给 Authenticated Users 的 Modify 会继承进去 —— 低权 agent 能写管理员的 DSH home
#    （.credentials.yaml、sessions、hindsight 全在里面）。探针 write-admin-dsh 抓的就是这个。
$adminDsh = Join-Path $AdminHome '.dsh'
$adminDshTarget = $null
try { $adminDshTarget = (Get-Item -LiteralPath $adminDsh -Force).Target | Select-Object -First 1 } catch { }
if (-not $adminDshTarget) { $adminDshTarget = $adminDsh }
Doing ('收紧管理员 DSH home：' + $adminDshTarget + '（Administrators/SYSTEM 全控，去掉 Authenticated Users/Users）')
if (-not $WhatIf) {
  [void](Run-Icacls @($adminDshTarget, '/grant', ($me + ':(OI)(CI)F')))
  [void](Run-Icacls @($adminDshTarget, '/grant', 'NT AUTHORITY\SYSTEM:(OI)(CI)F'))
  [void](Run-Icacls @($adminDshTarget, '/grant', 'BUILTIN\Administrators:(OI)(CI)F'))
  [void](Run-Icacls @($adminDshTarget, '/inheritance:r'))
  $c = Run-Icacls @($adminDshTarget, '/remove:g', 'NT AUTHORITY\Authenticated Users', 'BUILTIN\Users', '/T', '/C', '/Q')
  if ($c -eq 0) { Ok '已收紧（递归）' } else { Warn ('递归收回有失败 exit=' + $c + '：父目录已挡住穿越，个别文件残留不致命') }
  $aclDsh = (& icacls.exe $adminDshTarget 2>&1) -join "`n"
  if ($aclDsh -match 'Authenticated Users' -or $aclDsh -match 'BUILTIN\\Users:') { Fail 'DSH home 仍对其它本机用户开放' } else { Ok 'DSH home 已只给管理员/SYSTEM' }
}

}

# ── 5 注册低权任务 ─────────────────────────────────────────────────────────
Step '注册低权 headless 计划任务'
# 注册前留一份现任务 XML：Register-ScheduledTask -Force 是「先删后建」，中途失败或被杀
# 会让任务整个消失（本机 11-07 真发生过）。有备份就能一条命令恢复。
$taskXmlBackup = Join-Path $SecretsDir 's4-task-backup.xml'
try { Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $taskXmlBackup -Encoding UTF8 -ErrorAction Stop } catch { }
$argLine = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}\ci\s4-run-headless.ps1" -JobDir "{1}\current" -TriggerSafe' -f $Repo, $JobRoot
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
# 每 5 分钟一次的空转不该在桌面上闪一下控制台：动作带 -WindowStyle Hidden，
# 任务本身也标记为 Hidden（任务管理器/计划任务库默认折叠，不影响运行）。
$settings.Hidden = $true

# 定时触发器：每 5 分钟叫一次，带 -TriggerSafe（没 job.json 就空转成功，征用后改名 .running 防重跑）
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
Doing ('Register-ScheduledTask ' + $TaskName + '（以 ' + $AgentUser + ' 身份、每 5 分钟触发、-TriggerSafe）')
if (-not $WhatIf) {
  New-Item -ItemType Directory -Path (Join-Path $JobRoot 'current') -Force | Out-Null
  [void](Run-Icacls @((Join-Path $JobRoot 'current'), '/grant', ($AgentUser + ':(OI)(CI)M')))
  try {
    if ($LogonType -eq 'S4U') {
      $principal = New-ScheduledTaskPrincipal -UserId $AgentUser -LogonType S4U -RunLevel Limited
      Register-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings -Trigger $trigger -Principal $principal -Force | Out-Null
    } else {
      if (-not $password) { throw '没有密码（见第 2 步），Password 登录方式注册不了' }
      Register-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings -Trigger $trigger -User $AgentUser -Password $password -RunLevel Limited -Force | Out-Null
    }
    $t = Get-ScheduledTask -TaskName $TaskName
    Ok ('已注册：' + $t.TaskName + ' run-as=' + $t.Principal.UserId + ' logon=' + $t.Principal.LogonType + ' trigger=' + @($t.Triggers).Count)
  } catch {
    # 注册失败时任务可能已经被删掉了，先用备份恢复，再报错 —— 别留下「任务不存在」的空窗。
    if (Test-Path -LiteralPath $taskXmlBackup) {
      try { Register-ScheduledTask -TaskName $TaskName -Xml (Get-Content -LiteralPath $taskXmlBackup -Raw) -Force | Out-Null; Warn '注册失败，已用备份 XML 恢复旧任务' } catch { }
    }
    Fail ('注册失败：' + $_.Exception.Message)
  }
}

# ── 6 验收 ─────────────────────────────────────────────────────────────────
if ($Verify) {
  Step '验收：以低权身份跑隔离自检（ci\s4-probe.ps1）'
  $probeOut = Join-Path $JobRoot 'probe.json'
  $pargs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}\ci\s4-probe.ps1" -Out "{1}"' -f $Repo, $probeOut
  if ($VerifyEntry) { $pargs = $pargs + ' -SkipEntry:$false' } else { $pargs = $pargs + ' -SkipEntry' }
  $paction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $pargs
  $psettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

  if ($WhatIf) {
    Doing ('DRY: 注册一次性探针任务 ' + $ProbeTaskName + '，启动并等 ' + $probeOut)
  } else {
    try {
      if (Test-Path -LiteralPath $probeOut) { Remove-Item -LiteralPath $probeOut -Force }
      if ($LogonType -eq 'S4U') {
        $pp = New-ScheduledTaskPrincipal -UserId $AgentUser -LogonType S4U -RunLevel Limited
        Register-ScheduledTask -TaskName $ProbeTaskName -Action $paction -Settings $psettings -Principal $pp -Force | Out-Null
      } else {
        Register-ScheduledTask -TaskName $ProbeTaskName -Action $paction -Settings $psettings -User $AgentUser -Password $password -RunLevel Limited -Force | Out-Null
      }
      Start-ScheduledTask -TaskName $ProbeTaskName
      $deadline = (Get-Date).AddMinutes(21)
      while (-not (Test-Path -LiteralPath $probeOut) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
      Start-Sleep -Seconds 2
      $lastResult = $null
      try { $lastResult = (Get-ScheduledTaskInfo -TaskName $ProbeTaskName).LastTaskResult } catch { }
      Unregister-ScheduledTask -TaskName $ProbeTaskName -Confirm:$false -ErrorAction SilentlyContinue

      if (-not (Test-Path -LiteralPath $probeOut)) {
        Fail ('探针没产出结果（LastTaskResult=' + $lastResult + '）')
      } else {
        $doc = [System.IO.File]::ReadAllText($probeOut, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        Say ('    探针以 ' + $doc.user + ' 身份运行：')
        foreach ($c in $doc.checks) {
          $line = ('      {0,-18} 期望 {1,-5} {2}  {3}' -f $c.id, $c.expected, $(if ($c.pass) { 'PASS ' } else { 'FAIL ' }), $c.detail)
          if ($c.pass) { Write-Host $line -ForegroundColor Green } else { Write-Host $line -ForegroundColor Red }
        }
        if ($doc.allPass) { Ok '隔离自检全过（8/8）' } else { Fail ('隔离自检失败：' + (@($doc.failed) -join ', ')) }
      }
    } catch {
      Fail ('验收失败：' + $_.Exception.Message)
    }
  }
}

# ── 7 收尾 ─────────────────────────────────────────────────────────────────
Say ''
Say '==== 结果 ===='
if ($script:fails.Count -eq 0) {
  Say '全部步骤 OK。' -ForegroundColor Green
} else {
  Say ('有 ' + $script:fails.Count + ' 项失败：') -ForegroundColor Red
  foreach ($f in $script:fails) { Say ('  - ' + $f) -ForegroundColor Red }
}
Say ''
Say '下一步（本脚本不做，是下一个垂直切片）：'
Say '  ci/dispatch.mjs:1864 那个 spawn headless-task.sh，改成「写 job.json → Start-ScheduledTask'
Say '  DSHAgentHeadless → 等 done.json」；调度器自己继续以 Administrator 跑。'
Say ''
Say '回滚：'
Say ('  net user ' + $AgentUser + ' /delete')
Say ('  icacls "D:\code" /restore "' + $aclBackup + '"')
Say ('  Unregister-ScheduledTask -TaskName ' + $TaskName + ' -Confirm:$false')
Say ''

if ($script:fails.Count -gt 0) { exit 1 }
exit 0
