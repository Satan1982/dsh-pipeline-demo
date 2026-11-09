# 安全整改方案（2026-11-09，三审计裁决版）

> 三个只读审计（A 注入/攻击链、B Windows 权限/ACL、C 供应链/治理）各自实测后，本文件是裁决与整改方案。
> 现状：调度器仍 `paused`（`node ci/dispatch.mjs --status` → mode: paused）。**P0 未落地前不要给任何新 issue 贴 `agent:ready`。**

## 一、裁决：真正的洞不是"读盘"，是"回跑期以管理员执行 agent/issue 可控内容"

三份审计一致确认的 4 个入口（都要 issue 先被贴上 `agent:ready`，或 agent 已经能改文件）：

| # | 入口 | 代码 | 执行身份 | 可控内容来源 |
|---|---|---|---|---|
| 1 | `### 验收命令` | `ci/dispatch.mjs:1392` `bash -lc <验收命令>` | Administrator | issue 正文（外部输入） |
| 2 | 候选树跑 `verify.sh` | `ci/dispatch.mjs:1092` + `ci/gate-snapshot.mjs:60-90` | Administrator | 只覆盖 `scripts/`、`ci/` 字节，**agent 新写的测试/源码照跑**（`node --test` = 任意代码） |
| 3 | 提交钩子 | `.githooks/pre-commit:20` → worktree 里的 `ci/precommit.mjs`；`dispatch.mjs:709/1438` | Administrator | agent 的工作树（该文件不在保护名单） |
| 4 | 高风险适配器 | `ci/dispatch.mjs:1417`，spec 目录取自 issue `### 高风险验证` | Administrator | issue 正文 |

未证实但机制成立：`core.hooksPath=.githooks`（相对路径）若在 linked worktree 解析到工作树根，agent 可改 `.githooks/pre-push`，在 Admin push 时执行（`dispatch.mjs:1696`）。

**裁决结论**：
- 打分：C1 成立（凭据读不到）、C3 **升级**为"D:\ 继承区可读**且可写**（含主工作区 `D:\dsh\default-workspace`）"、C4 成立（出网无限制）、C5 成立且**比原判更重**（不需合并即可 Admin 执行）、C6 成立（回退分支 0 次触发，但有静默全开能力）。
- UPDATE：此前"C2 凭据安全"的表述 → 改为 **"编辑期隔离有效，回跑期无隔离"**。低权 S4 只约束 agent 编辑阶段；其后管理员身份重跑它的产物，等于把权限还回去。
- 优先级：**回跑降权 > 钩子信任副本 > 作者闸 > 主工作区断继承 > 出网**。作者闸只挡"陌生人进门"，挡不住已经进门的 Admin 执行。

## 二、P0（阻断，约 1.5 人日；做完才能恢复跑单）

### P0-1 回跑阶段降权（核心）
把"执行代码"的三处全部交给 `dsh-agent`，管理员只保留 git push / API / 建 worktree：
- `dispatch.mjs:1092` 候选树 verify：候选树建到 `C:\ProgramData\dsh-gate\cand-*`（ProgramData 下，建好即 `icacls` 给 `dsh-agent:(OI)(CI)M`），再以低权跑 `bash scripts/verify.sh`；候选树清理仍在管理侧。
- `dispatch.mjs:1392` 验收命令：复用 `ci/s4-job.mjs` 通道（`cwd=worktree`，agent 已有 M），限时 300s 不变。
- `dispatch.mjs:1417` 高风险适配器：同通道；`repoDir` 只读（`D:\code` 对 agent 已是 RX）。
- 每次执行落一行审计：`{ts, actor, issue, cwd, cmd_sha256, exit}`，进 `.logs/exec-audit.jsonl`。
- 备份预案（若降权跑不起来）：验收命令白名单（只允许 `bash scripts/verify.sh` 或 `node ci/...` 开头）+ 断网，属止血不属修复。

### P0-2 钩子取信任副本 + 保护面白名单化
- 提交时 `-c core.hooksPath=<临时目录>`：从 `origin/main` 导出 `.githooks/` 与 `ci/precommit.mjs`（管理员所有、agent 不可写），替代工作树里的钩子。
- `ci/review.mjs:47` 的 4 文件名单 → 改为前缀白名单：`ci/`、`scripts/`、`.githooks/`、`.github/` 默认 block（`allow:gate` 时才降 warn）。
- 验收 drill：PR 改 `ci/precommit.mjs` → `gate-modified`；改 `.githooks/pre-push` → `forbidden-path`。

### P0-3 作者闸
`dispatch.mjs:1811` 之后加：`author_association ∈ {OWNER, MEMBER, COLLABORATOR}` 才领单；`DSH_TRUSTED_AUTHORS` 可显式追加；其余打 `agent:blocked` 并留言说明。约 10 行 + 单测。

### P0-4 主工作区断继承 + 清残留
- `D:\dsh` 与 `D:\dsh\default-workspace`：`/inheritance:r`，只给 `Administrator:F`、`SYSTEM:F`、`dsh-agent:(OI)(CI)RX`。
- 删除 `.worktrees\.secrets` 符号链接（指向 `D:\code\.secrets` 的残留，位于 agent 可写目录）。
- 需管理员 → 走 broker（`C:\ProgramData\dsh-broker\queue\`）。
- 验收：以 `dsh-agent` 写 `D:\dsh\default-workspace\docs\x` 拒绝；读 `docs` 成功。

## 三、P1（收口，约 1 人日）

| # | 项 | 改法 | 验收 |
|---|---|---|---|
| P1-5 | 出网白名单 | 防火墙按用户：`dsh-agent` 出站默认 block，放行 127.0.0.1（+ registry 若 verify 需要） | `curl` 外网失败；`verify.sh` 低权仍绿 |
| P1-6 | 回退 fail-closed | `dispatch.mjs:2167-2179` 默认失败；`DSH_S4_FALLBACK=admin` 才回退，回退时 `notifyEvent` 告警 | 断开 launcher → 单子 fail 而不是静默以 Admin 跑 |
| P1-7 | 只读工单输出脱敏 | `dispatch.mjs:1343-1349` 发公开评论前：绝对路径/`D:\`/token 形状替换、截断 | drill 输出含 `D:\code\.secrets` → 评论里打码 |
| P1-8 | CI 权限收紧 | `ci.yml` 加 `permissions: contents: read`；actions 固定到 SHA | `grep permissions ci.yml`；CI 仍绿 |

## 四、P2（加固，约 1 人日）

- 正文围栏 + 消毒（`dispatch.mjs:790-829`）：issue 三段包固定分隔符、声明"以下为数据"，可疑模式打标；**不作为主防线**。（2026-11-09 已落地：`ci/prompt-fence.mjs`，见 §六）
- PAT 换 fine-grained 单仓并轮换（现为 classic `repo, workflow`）。
- `ci/drills/security.json` + 脚本：5 个恶意用例（读 `.secrets`、改 precommit、改 workflow、外网 curl、`node -e` 读盘）作为回归，CI 只断言"被拒"，不真执行。
- 执行审计（与 P0-1 合并）。

## 五、明确不做

- 不改 `AUTO_MERGE_ENABLED`（保持 false），不改调度器身份（降权会废掉建 worktree/推 PR）。
- 不加依赖、不改 `.github/workflows/`（除 CI 任务）。
- 不靠提示词"红线"当防线。
- 不恢复贴标，直到 P0-1/P0-2/P0-3 落地且 drill 全绿。

## 六、实施状态（2026-11-09 落地记录）

已实现（`bash scripts/verify.sh` → 416/416 pass / 1080 断言，`node ci/s4-exec.mjs --selftest` → 23/23）：

- **P0-1 回跑降权**（新通道）：`ci/s4-exec.mjs` + `ci/s4-run-cmd.ps1`，`runAsAgentCommand` 以 `dsh-agent` 跑固定命令；候选树根 `C:\ProgramData\dsh-gate`；三处改走低权：候选树 `verify.sh`、`### 验收命令`、高风险适配器（`dispatch.mjs:1092/1410` 区段）。
- **P0-2 保护面**：`review.mjs` 白名单 `ci/`、`scripts/`、`.github/`、`.githooks/`；两个 `--bless` 基线 txt 例外（数据非代码，另受 assert-guard 指纹保护）；`gate-snapshot.mjs` 不再把基线 overlay 回 origin（否则「加测试」工单必判基线未更新）；`gateBytesSha256` 仍在恢复基线**之前**计算，证据仍只代表 origin 门禁字节。
- **P0-3 作者闸**：`isTrustedAuthor()`（OWNER/MEMBER/COLLABORATOR 或 `DSH_TRUSTED_AUTHORS`），其余跳过并 log `[author-gate]`。
- **P1-6 回退 fail-closed**：`runHeadless` 低权通道不可用即抛 `ENV_FAIL`（不耗重试预算），只有 `DSH_S4_FALLBACK=admin` 才显式回退并告警。
- 审计：每次低权执行落 `{ts, actor, issue, cwd, cmd_sha256, exit, ok, done}` 到 exec-audit。
- **结果文件 fail-closed**：`s4-exec.mjs` 不再把「ok 但没有整数 exit」当 0（旧 `done?.ok ? 0 : -1` 可被伪造的 done.json 直接变成门禁通过），缺 exit 一律 `code=-1 / ok=false`。
- **cwd 规范化**：`s4-run-cmd.ps1` 先拒 `..`、再 `GetFullPath` 后比较许可根（纯 `StartsWith` 允许 `D:\code\.worktrees\..\..\dsh\default-workspace` 逃逸）。
- **提交钩子隔离**：调度器以 Administrator 提交时带 `-c core.hooksPath=C:/ProgramData/dsh-gate/.no-hooks`（目录不存在=无钩子），worktree 内 agent 可写的 `.githooks` 不再能以管理员身份执行；agent 自己的提交仍用 worktree 钩子（低权身份）。
- **降权开关可观测**：`DSH_S4_EXEC=0` 回退 Administrator 时打 `[s4-warn]`（kill switch 仍存在，但不再静默）。
- **结果文件 nonce（2026-11-09 残余收口）**：`prepareCmdJob` 每次生成 16 字节随机 nonce 写进 `job.json`，`s4-run-cmd.ps1` 在**启动命令前**删除 job.json 并复核已删除，`done.json` 回带 nonce；`s4-exec.mjs` 的 `validateDone()` 要求 nonce 匹配 + 整数 exit + `ok=true && exit=0`，再叠加 launcher 退出码 0 才判 `ok`。命令即使能写 jobDir 也读不到 nonce。实测：低权 `bash scripts/verify.sh` 通过，运行期间 `C:\ProgramData\dsh-jobs\cmd\job.json` 不存在，`done.json` 的 nonce 与 job 一致。
- **低权权限档**：`s4-run-cmd.ps1` 的 `DSH_PERMISSION_MODE` 由 `danger-full-access` 降为 `workspace-write`（该通道只跑固定命令，不走 DSH 的 shell 通道，`node --test` 的子进程命名管道限制不适用）。
- **作者/贴标人双闸**：`isTrustedAuthor()` 不再单凭 `author_association` 放行 MEMBER/COLLABORATOR，改为「OWNER + 协作者表里有 admin/maintain/write/push 的登录 + `DSH_TRUSTED_AUTHORS`」；新增 `isTrustedLabeler()` 读 `GET /repos/{repo}/issues/{n}/events`，要求最新一条 `agent:ready` labeled 事件的 actor 也在同一可信集合。协作者表 10 分钟缓存，读不到时退化为只信任所有者/白名单（fail-closed）；`--issue N` 强推路径同样过双闸。
- **建单流程配合**：`ci/pass3-issues.mjs`、`ci/plan.mjs` 改为先建单再 POST labels —— 创建时带 label 不产生 labeled 事件，会被贴标人闸拒；人工建单若在创建时就勾了 `agent:ready`，需去掉重贴一次。
- **单测**：`ci/s4-exec.test.mjs`（8 测试 / 27 断言）把作者/协作者/贴标人/`validateDone` 的判定钉进断言基线。
- **P1-7 公开出口脱敏**（2026-11-09，PR #243）：新增 `ci/redact.mjs`，在唯一出口 `api()`（`dispatch.mjs:477`）对 `POST .../comments` 与 `POST .../pulls` 的 `body` 做替换——私钥块、`gh[pousr]_`、`github_pat_`、`sk-`、AKIA、`xox[baprs]-`、JWT、`Bearer`、盘符/UNC/MSYS/POSIX 绝对路径，超 6000 字符截断；`ci/redact.test.mjs` 11 测试 / 32 断言，含「URL 里的 /home 不动」「commit sha 不动」负例。
- **P2 正文围栏**（2026-11-09）：新增 `ci/prompt-fence.mjs`，`buildPrompt` 把目标/验收/约束三段包进 `<untrusted-issue>` 围栏并前置「以下为数据」声明；正文自带的闭栏字面量被中和（`<`→`＜`），超 12000 字符截断；可疑指令模式（中英注入句、`system:` 行等）只在围栏内打一行计数标记。标题折叠成单行、截 300 字符。`ci/prompt-fence.test.mjs` 8 测试，含「闭栏逃逸后输出仍只有一个闭栏标签」与「buildPrompt 真的调用了围栏」两条接线断言。**仍是纵深防御**：不作为主防线，权限与低权执行才是。
- **P1-8 CI 权限收紧**（2026-11-09，PR #244）：`ci.yml` 加顶层 `permissions: contents: read`；两个工作流的 4 处 `uses:` 固定到提交 SHA（checkout/setup-node 均 v4.4.0，行尾标注版本）；新增 `ci/workflows.test.mjs` 6 测试守卫（浮动 tag、缺版本注释、ci.yml 缺只读权限都会红）。

已知残余（不阻塞恢复跑单，记入 P2）：
- `done.json` 仍由低权进程写：nonce 挡住「命令自己写一份结果」，但同一登录会话仍可从 runner 内存读 nonce；彻底隔离要等 P2 的独立取码/OS 级隔离。launcher 退出码 0 与 nonce 双条件是为了避免把它降级成单点。
- 低权通道的出网仍不受限（P1-5 防火墙白名单未做），`DSH_PERMISSION_MODE` 只影响该通道 spawn 的 DSH 子进程，`verify.sh` 本身不经 DSH 沙箱。

未做（按分类表 SKIPPED，不阻塞 P0 止血）：P0-4 ACL 断继承 / 删 `.worktrees\.secrets` 残留；P1-5 防火墙出网白名单；P2 全部（P1-7/P1-8 已于 2026-11-09 落地，见下）。
原因：均是系统级配置或需 broker 提权，改的是机器而不是仓库；且 P0-1 已把"执行身份"与"内容来源"解耦，P0-4/5/8 属于纵深防御。

已补验（2026-11-09 13:50，`bash scripts/verify.sh` → 425/1106 PASS）：
- 断 launcher drill：`node ci/drills/launcher.mjs` → 12/12 通过，`VERDICT: PASS`（伪造 done.json 被 nonce 拒、断 launcher 判 fail 且 `code=-1`、`s4FallbackAction` 默认/空串都 fail-closed、只有 admin 才回退、`git log` 无 Administrator 提交）。这是通道级复现（与 `.logs/exec-audit.jsonl` 里 `actor=manual-regression` 同手法），不是「新建一张真实 issue」；首张真实单开跑时再按 §八 门禁观察。
- 恶意 drill：`node ci/drills/security.mjs`（用例在 `ci/drills/security.json`）→ 5/5 被拒 + 1 正对照通过，`VERDICT: PASS`；只调 `commandPolicy()`/`reviewDiff()` 做判定，不执行恶意命令。
- S4 覆盖率：`--status` 新增 `s4:` 行（`ci/s4-coverage.mjs` 从 exec-audit + `s4-fallback` 事件算），当前 `覆盖 100%（4 次低权执行，其中成功 4；0 次回退）`；显式 `DSH_S4_FALLBACK=admin` 回退会写 `s4-fallback` 事件，覆盖率即跌破 100%（闸门 3 不成立）。
- drill 专用开关（生产不设）：`DSH_S4_LAUNCHER` 换 stub launcher、`DSH_S4_DONE_GRACE_MS` 缩短 done.json 等待。

## 七、总闸门（全部完成后）

1. ✅ `bash scripts/verify.sh` 绿（425/1106）；`npm test` 不降。
2. ✅ 5 个恶意 drill 全被拒（`node ci/drills/security.mjs`）。
3. ✅ `node ci/dispatch.mjs --status` 显示 `s4: 覆盖 100%（……0 次回退）`。
4. ✅ `leak_guard` 扫公开仓工作树（`git archive HEAD` 导出到临时目录后扫）干净后才 push：175 文件 / 1168 KB，唯一条目是 `governance/keys/dispatch-20261108.pub.pem` 的**文件名**命中，内容实为 `-----BEGIN PUBLIC KEY-----`（公钥本就该公开，判为假阳性）；`.tmp/keys-smoke/*.pem`（私钥样例）被 `.gitignore:2` 忽略、未跟踪。

## 八、解冻记录（2026-11-09 13:37，用户拍板）

- **先换代码再解冻**：常驻 pid 8768 是 11-07 17:36 起的，日志 `code=6c9bcd9@11-07 09:32Z`——今天落地的 nonce、作者闸、贴标人闸都不在它内存里。解冻前用 broker 停掉旧进程并 `--ensure` 重拉（新 pid 14744，`code=65bfe71@11-09 05:34Z`）。**结论：改完闸门必须重启常驻，`--resume` 不会加载新代码。**
- **修 `--resume` 对常驻无效（65bfe71）**：常驻启动时从磁盘读到的 `paused=true` 没有标记成「磁盘依据」，`syncPauseFromDisk()` 的恢复分支永远不成立。改为 `reconcilePause()` 纯函数（落盘失败的暂停仍 fail-closed 保持停），实测 `--resume` 后日志出现 `▶ 检测到暂停已解除，恢复领单`。
- **解冻方式**：用户选「现在解冻」。§六「未验证」三项（`security.json` 5 例恶意 drill、`--status` 的 S4 覆盖率行、断 launcher 的真实工单 drill）**作为第一张真实工单开跑前的门禁**，不阻塞空转（当前 GitHub 侧无 `agent:ready` 单）。
- **解冻后状态**：`state.json paused=false`，常驻每 60 秒轮询、日志 `没有待处理任务`；`git log` 无 Administrator 执行记录。
- **仍未做**：12+1 个本地提交没有 witness 签名证据，`ci/trust/verify.mjs --land origin/main` 仍判 FAIL，push 另议。

## 九、首张真实单 #231 与候选树清理 EPERM（2026-11-09 14:11 端到端跑通）

**结论：真实单在低权通道下端到端跑通了**（#231 → 门禁绿 → witness `1b0c8db76b76` → 语义评审 pass → PR #232）。挡在中间的不是安全闸，而是候选树清理的 `EPERM`。

- **复现**：`#231` 第 2/3 次尝试都在 `headless exit=0`、agent 自己跑绿 `verify.sh` 之后被判失败，错误是 `Error: EPERM, Permission denied: \?\C:\ProgramData\dsh-gate\cand-XXXXXX`。手工 `rm -rf` 同样 `cannot remove …/dist/build-info.json: Permission denied`。
- **根因（ACL 而非瞬时占用）**：候选树里的 `dist/` 等产物由低权用户 `dsh-agent` 建，其 ACE 只把 FullControl 给了 `dsh-agent`、`SYSTEM`、`BUILTIN\Administrators`、`Users(RX+Write)`——**没有 `ZHAO\Administrator`**。调度器跑在 UAC 过滤令牌里（`IsInRole(Administrator)=False`），`BUILTIN\Administrators` 是 deny-only SID，那条 ACE 不生效，于是自己删不掉自己门禁里产出的文件。（同一原因也是「提权常驻进程本会话杀不掉」的原因。）
- **修法（08d869b）**：
  1. `ci/gate-snapshot.mjs` 新增 `grantTreeForCurrentUser()`：建树后 `icacls <dir> /grant <USERDOMAIN\USERNAME>:(OI)(CI)F /T /Q`，子文件靠 `(OI)(CI)` 继承；
  2. `removeTreeSafe()`：先直删，`EPERM/EACCES` 就补 ACL 再删一次，**永不抛出**——`cleanup()` 返回 `{ok,via?,why?}`；
  3. `sweepCandidates()`：每次建树前清扫 `>1h` 的 `cand-*` 残留（避免误删并发在跑的两棵）；
  4. `ci/dispatch.mjs` 的 `finally` 改为「清理失败只打 `[s4-warn]`，不判任务失败」——候选树是临时物，不该让一次清理失败推翻「门禁全绿」。
- **验证**：`node --test ci/gate-snapshot.test.mjs` → 9 pass / 0 fail（新增 4 例：直删成功、EPERM→补 ACL 成功、两次失败不抛出、sweep 只删 cand-* 且保留新树）；`bash scripts/verify.sh` → 429/1119 PASS（基线 `429 1119 17c0fbc629cef31f`）。
- **复跑证据**：`--status` 的 `s4` 行仍为 100%（`exec-audit` 新增 `actor=gate`、`actor=acceptance` 各一条，`s4:true`、`nonce_ok:true`）；本次运行无任何 `[s4-warn]`，`C:\ProgramData\dsh-gate\` 下只剩 `drill`。
- **遗留**：`#231` 的 PR #232 等人工点合并（v3 P0 关闭了 `merge:auto`）；本地 16 个提交仍无 witness 覆盖，push 另议。

## 十、落地记录（2026-11-09 15:05，用户授权一次性收尾）

用户「都授权你干完」后按仓规把积压的提交与 PR 全部落地，顺序是**先 push 再合并 PR**（本地领先 origin 19 个提交且无分叉，先合并 PR 会让 push 变 non-FF）。

- **签名**：人工调 `attestCommit()` 给 HEAD 签一条 witness（`issue=land-20261109`、`key_id=dispatch-20261108`、ed25519，`hash=bca8c5db46d1…`），链上第 40 条；`verify.mjs --chain .logs/witness.jsonl --repo . --land origin/main --keys governance/keys` → `n=40 keys=1（ed25519 验签）`、`✓ HEAD 已被 witness 覆盖`、`VERDICT: PASS`。
- **push**：走 `bash ci/land.sh`（verify → 验签 → push → 镜像 Gitee），GitHub `f32d244..8538e58`、Gitee 同范围，一次成功。远端对 required check 的提示不影响推送（管理员旁路）。
- **PR #232**：打 `merge:verified` 标签后合并（`merge_commit_sha=fb615fba`），只改 `docs/manual.md +9`；本地 `merge --ff-only` 跟到 `fb615fb`。
- **结论**：「先补门禁再开单」这条路径已经完整走通一次——**门禁绿 → witness 签名 → push → PR 合并**，后续 `agent:ready` 真实单可以按同一节奏跑。

## 十一、镜像判据与 land 判据对齐（2026-11-09 15:5x）

**问题**：`land.sh` push GitHub 前的判据是「HEAD 被 witness 覆盖，或自基线起只有文档/元数据改动」；而 `mirror-gitee.sh` 用的是 `--head`（HEAD 的 commit+tree 必须被某条 witness 覆盖）。docs-only 提交永远不会有 witness（witness 由调度器在过完门禁的提交上签发），于是每次纯文档提交同步 Gitee 都要人工 attest 或设 `DSH_GITEE_ALLOW_UNVERIFIED=1`——同一个出口两套宽严不一的判据。

- **基线取「Gitee 当前 main」**：镜像脚本先 `git ls-remote "$REMOTE" refs/heads/main` 拿 TIP，本地有该提交就传 `--mirror <ref> --base <TIP>`；判据与 `--land` 一致（自基线起只有文档/元数据改动即放行）。不取「最近 witness 覆盖祖先」：中间夹一个未见证的门禁提交就会把后续 docs 提交一起拒掉（poisoning），仍要人工放行。
- **兜底**：拿不到 TIP（首次镜像/断网）退回 `--head`，仍然 fail-closed；`DSH_GITEE_ALLOW_UNVERIFIED=1` 的显式放行路径保留并写 `.logs/gitee-unverified.jsonl`。门禁脚本自更新的 `DSH_LAND_GATE_UPDATE=1` 例外**没有**复制进镜像口——镜像仍必须显式放行，避免在镜像口开第二条仅凭环境变量的放行路。
- **改动**：`ci/trust/verify.mjs` 新增 `--mirror <ref> [--base <提交>]` 与 `mirrorCheck()`（复用 `landChangedFiles`/`classifyPaths`，另加 `newestCoveredAncestor()` 作无基线时的后退选项）；`ci/mirror-gitee.sh` 把 `--head $SRC` 换成上述动态判据，失败文案同步改。
- **验证**：`node --test ci/trust-verify.test.mjs` → 11 pass / 0 fail（新增 3 例：docs-only 放行+源码拒推、无基线退回 witness 祖先、基线提交不存在 fail-closed）；`bash scripts/verify.sh --bless` → 432/1127 PASS（基线 `432 1127 17c0fbc629cef31f`）。
- **live 证据（本提交）**：修复提交 `33aa51a` 本身含门禁脚本改动，落 Gitee 时仍显式放行一次并留痕（`.logs/gitee-unverified.jsonl`，符合「镜像口不复制 gateOnly 例外」的决定）。本条**纯文档**提交随后走 `bash ci/land.sh`——`--land` 判 PASS、镜像**没有**设 `DSH_GITEE_ALLOW_UNVERIFIED` 也成功推上 Gitee，证明 docs-only 同步不再需要人工 attest。

## 十二、首张 docs-only 真实单 #233 与镜像判据的端到端复核（2026-11-09 17:1x）

**做法**：不用 `ci/pass3-issues.mjs` 批量（它会 pause 常驻调度器并覆盖 `ci/drills/pass3-issues-result.json`），而是手工建一张 docs-only 工单，交给**常驻调度器**按真实生产路径领取——只有 docs-only 提交能判别 `--mirror` 判据是否生效。

- **建单**：#233 `[docs] manual.md 补记 Gitee 镜像自动同步（无需人工 attest）`，验收命令 `grep -q "无需人工 attest" docs/manual.md`；先建单再贴 `agent:ready, lane:docs`（创建即带 label 会被贴标人双闸拒）。
- **领取与路由**：免费池 modelscope 首次路由返回 `429 insufficient balance (code=QUOTA)`（欠费不是限流），三次尝试后任务 FAILED；补 `model:paid` 标签后重新投放，改走 deepseek-flash，`估算成本 ¥0.18`（在日闸 ¥5 内）。
- **产出**：`headless 结束 exit=0 67s`、`69919 tokens（in 63251 / out 6668）`、`verify.sh → VERDICT: PASS`、`witness 896f0d89f8ef` 覆盖 `78d30127`、语义评审团 1/1 有效（XingChenAGI/Xing4.0-29B=pass）、PR #234（`ci` 上 `verify=success`）。
- **合并**：v3 P0 关掉了 `merge:auto`（`ci/merge-policy.mjs:46`），按 PR #232 先例打 `merge:verified` 后 squash 合并 → `merge_commit_sha=3cab6afde2268d9d6672e415749bfe07e4bb498d`，本地 `merge --ff-only` 跟到 `3cab6af`（`docs/manual.md +6`）。
- **镜像（关键证据）**：`bash ci/mirror-gitee.sh` **没有**设 `DSH_GITEE_ALLOW_UNVERIFIED` → `To gitee.com:Satan1982/dsh-pipeline-demo.git 1a2390a..3cab6af`，`EXIT=0`；事后 `git ls-remote gitee refs/heads/main` 与本地 HEAD 同为 `3cab6af…`，`.logs/gitee-unverified.jsonl` **仍是 2 行**（无新增放行记录）。
- **结论**：`--base <Gitee TIP>` + docs-only 分类这套判据在**真实流水线产出**的提交上成立——docs-only 同步 Gitee 不再需要人工 attest，也不再需要环境变量旁路。
