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

- 正文围栏 + 消毒（`dispatch.mjs:790-829`）：issue 三段包固定分隔符、声明"以下为数据"，可疑模式打标；**不作为主防线**。
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

已知残余（不阻塞恢复跑单，记入 P2）：
- `done.json` 仍由低权进程写：nonce 挡住「命令自己写一份结果」，但同一登录会话仍可从 runner 内存读 nonce；彻底隔离要等 P2 的独立取码/OS 级隔离。launcher 退出码 0 与 nonce 双条件是为了避免把它降级成单点。
- 低权通道的出网仍不受限（P1-5 防火墙白名单未做），`DSH_PERMISSION_MODE` 只影响该通道 spawn 的 DSH 子进程，`verify.sh` 本身不经 DSH 沙箱。

未做（按分类表 SKIPPED，不阻塞 P0 止血）：P0-4 ACL 断继承 / 删 `.worktrees\.secrets` 残留；P1-5 防火墙出网白名单；P1-7 输出脱敏；P1-8 `ci.yml permissions`；P2 全部。
原因：均是系统级配置或需 broker 提权，改的是机器而不是仓库；且 P0-1 已把"执行身份"与"内容来源"解耦，P0-4/5/8 属于纵深防御。

未验证（恢复跑单前必须补）：
- 真实工单 drill：断开 launcher → 单子应 fail 而不是回退；`git log` 无 Administrator 执行记录。
- 恶意 drill 端到端（`ci/drills/security.json` 5 例）。
- `node ci/dispatch.mjs --status` 的 S4 覆盖率 100%（无回退记录）。


## 七、总闸门（全部完成后）

1. `bash scripts/verify.sh` 绿、`npm test` 不降。
2. 5 个恶意 drill 全被拒（`ci/drills/security.json`）。
3. `node ci/dispatch.mjs --status` 显示 S4 覆盖 100%（无回退记录）。
4. `leak_guard` 扫描公开仓工作树干净后再谈 push。
