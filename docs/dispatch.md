# 调度器（dispatch.mjs）

轮询 GitHub Issues，让 headless agent 在隔离 worktree 里干活，自动开 PR。人只写 issue + review/merge。

## 用法

```bash
# 跑一轮（本地验证）
node ci/dispatch.mjs --once

# 持续轮询，默认 60s
node ci/dispatch.mjs

# 只看有哪些待办，不执行
node ci/dispatch.mjs --dry-run
```

注意本机 PATH 没有 node，`node` 要换成随包绝对路径：

```
<DSH 安装目录>\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
```

## 端到端实测（2026-10-24）

| 步骤 | 结果 |
|---|---|
| 创建 Issue #1（divide 需求 + 验收标准） | 13:28:09 |
| 调度器领取 | 13:28:21 |
| headless 完成 | 13:29:24（42s） |
| 自动开 PR #2 | 13:29:33 |
| PR 改动 | 2 files, +17/-1 |
| 分支 CI | success |
| 人工 squash 合并 | sha `2aa9d8c` |
| 全程 | ~72s |

## 门禁（缺一个就不执行）

1. **验收标准必须存在**：issue body 必须有 `### 目标` 和 `### 验收标准（可执行）`，否则直接 `agent:failed` 并评论原因。没有验收标准的任务会做出"自洽但错"的结果。
2. **agent 不得触碰 origin/main**：跑前跑后对比 `origin/main` SHA，变了就中止并报错。
3. **无改动 = 失败**：worktree 里既没 dirty 也没新 commit → `agent:failed`。
4. **隔离 worktree**：任务在 `<工作盘>/.worktrees/issue-<N>` 执行，主工作区不受影响。

## label 约定

| label | 含义 |
|---|---|
| `agent:ready` | 提交通道，调度器会领取 |
| `agent:working` | 正在执行（防止重复领取） |
| `agent:done` | 已产出 PR |
| `agent:failed` | 执行失败，需人工处理后重新打 `agent:ready` 重试（先去掉 `agent:failed`） |

Issue 模板：`.github/ISSUE_TEMPLATE/agent-task.yml`，新建 issue 时选「自动化任务」自动带上 `agent:ready`。

**标签自动补齐（2026-10-28）**：GitHub 打一个不存在的标签是静默丢弃的（不报错、issue 上也不多东西），所以调度器拿锁后在轮询前跑一次 `ensureLabels()`（清单在 `ci/labels.mjs`，14 个），缺的用 `POST /repos/:o/:r/labels` 建上，日志 `[labels] 补齐 N 个缺失标签：agent:blocked:manual 等 N 个`；已齐时不写日志。读不到/建不了只记一行 `[labels] …` 并继续跑（标签管理要 `issues:write`，权限不足不该让任务停摆）。`--dry-run` 只打印 `[dry-run] [labels] 缺 N 个标签…` 不发请求；`dep-on:<任务号>` 由人随手加，不纳入自动补齐。

## 失败重试（已实现）

执行期失败（headless 非 0 退出、无改动、碰了 origin/main）会自动重试，上限 3 次（`DSH_MAX_ATTEMPTS`）：

1. 失败后把错误栈写进 issue 评论（第 1 次、第 2 次各一条）
2. 重试时把完整失败原因回灌进 prompt 的「上次失败原因」段，要求针对性修复
3. 3 次都失败 → 摘掉 `agent:ready`、打 `agent:failed`、评论「N 次尝试均失败」

实测（2026-10-24，用 `DSH_DEBUG_FAIL_ATTEMPTS=3` 强制前 3 次失败）：

```
[issue #3] 第 1/3 次失败，自动重试：Error: [debug] 强制第 1 次尝试失败
[issue #3](第 2 次) 第 2/3 次失败，自动重试
[issue #3](第 3 次) FAILED: 3 次尝试均失败。
```

结果：issue #3 label 只剩 `agent:failed`，评论 3 条（两次重试 + 最终失败）。
正常路径未受影响：issue #4 → 73s → PR #5。

调度器重启时会清理孤儿 `agent:working` label（上一个进程崩了会留下），否则那些 issue 会被永久跳过。

## 并发（已实现）

`DSH_CONCURRENCY`（默认 2）控制同时跑几个 issue。每个 issue 有独立的 worktree
`<工作盘>/.worktrees/issue-<N>` 和独立分支 `agent/issue-<N>`，互不干扰。

`.git/worktrees` 本身不是并发安全的，`setupWorktree()` 与 worktree 删除都走进程内
`locked()` 互斥，避免 `git worktree add` 同时写同一份元数据。

实测（3 个 issue，并发 2）：#9/#10 同时领取 → 各约 2 分 40 秒完成（PR #11、#12）→
立刻领取 #8 → 4 分 17 秒全部收尾，三个分支 CI 全绿。

## CI 失败回环（已实现）

PR 的 CI 红了不需要人再打 label：`checkAgentPRs()` 会

1. 列出 open PR 中分支名形如 `agent/issue-<N>` 的；
2. 取该分支最新一次 `completed` 的 ci run，`conclusion=failure` 才处理；
3. 从 `actions/runs/<id>/jobs` 找失败 job，再从 `actions/jobs/<job_id>/logs` 取纯文本日志；
4. 把日志回灌给 headless，要求复现并修好；
5. 提交 `agent: fix CI for issue #N`、推回同一分支、评论一条带
   `<!-- ci-retry-run:<runId> -->` 的说明（同一次 run 只触发一次修复）。

实测：往 `agent/issue-6` 推了一个语法错误的 commit（`1b90001`），run 40105361670 失败
→ 调度器 162 秒后自动修复并推 `4c02e51` → 新 run 40105723850 success。

修复轮次与首次实现共用 `DSH_MAX_ATTEMPTS`（默认 3），超限把 issue 打到 `agent:failed`
并请人接手。注意 headless 修复时可能 exit=1 但改动是有效的，所以判定只看「有没有产生
新 commit」，不看退出码。

## 测试基线守卫（挡住「删测试凑绿」）

prompt 里写「禁止删测试」不管用——实测 PR #13 就把 `divide rejects zero divisor` 整条删了。
现在改成机器强制：

- `scripts/test-baseline.txt` 存 `<测试数> <断言数>`，当前 `17 41`。
- `scripts/verify.sh` 跑完测试后解析 `ℹ tests` / `ℹ fail`，再数一遍 `assert.`，任一低于基线就
  `exit 1`；高于基线只提示，跑 `bash scripts/verify.sh --bless` 才更新文件。
- CI 额外一步 "Test baseline must not shrink"：对比 `origin/<base_branch>` 的基线文件，降低就红。
  这一步挡的是「同一个 PR 里既删测试又降基线」这种绕过。

实测三条路径（2026-10-24）：

```
删掉 stats 的一个 test   → ℹ tests 16 → 拒绝：测试数量从 17 降到 16
只删一条 assert          → 拒绝：断言数量从 41 降到 40
新增 test                → 基线可上调：tests 17→18, asserts 41→42 → --bless 后 18 42
```

## 模型选择（`model:strong`）

默认走 `siliconflow/Xing4.0-29B`（免费）。复杂需求（多文件协调、要补契约细节）给 issue
加 `model:strong` label，调度器会把 `DSH_HEADLESS_PATCH` 换成
`<secrets 目录>/headless-model-strong.yml`，改用 `deepseek-ai/DeepSeek-V4.1-Flash`。

同一任务的对照实验（Issue #14 vs #15，任务都是「新增 stats 模块 + 改 verify.sh 让两个
测试文件都跑」）：

| | strong (PR #16) | 29B (PR #17) |
|---|---|---|
| 耗时 | 94 秒 | 253 秒（2.7×） |
| 断言数 | 5 条，含「median 不修改输入」的不可变契约 | 4 条，只有基本路径 + 空数组 |
| 文件卫生 | 保持末尾换行 | 把 `package.json`、`src/stats.js` 的末尾换行改没了 |
| CI | 绿 | 绿 |

两者实现都正确，但 strong 在「不该改的地方没乱改」和「顺手补契约」上明显更稳。结论：
日常小改动用 29B 省钱，一次要动 3 个以上文件或需要判断「改哪里才不越界」时加 `model:strong`。

## 无人值守

两种宿主形态，差别只在「谁负责定时拉起」：

**A. Windows 计划任务（重启存活）**

```powershell
powershell -ExecutionPolicy Bypass -File ci\install-task.ps1 -EveryMinutes 5
powershell -ExecutionPolicy Bypass -File ci\install-task.ps1 -Remove
```

每轮只跑 `--once` 就退出，进程崩溃不影响下一次触发；`MultipleInstances IgnoreNew` 防止上一轮没跑完时叠加；单轮 40 分钟硬上限，卡死会被系统杀掉。token 由 `dispatch.mjs` 自己从
`<secrets 目录>\github-token.txt` 读，不写进任务定义。

**B. 常驻进程（推荐，打开即用）**

```bash
node --use-system-ca ci/dispatch.mjs --ensure   # 没有常驻进程就脱离父进程拉起一个
node --use-system-ca ci/dispatch.mjs --serve    # 前台常驻（调试用，Ctrl+C 停）
node --use-system-ca ci/dispatch.mjs            # 等价于 --serve
```

`--ensure` 幂等：已有常驻进程时只打印 `常驻调度器已在运行（pid=…）` 就退出，不持锁、不等任务，
所以登录自启、手动重复点击都安全。常驻进程每 60 秒一轮（`DSH_POLL_INTERVAL` 按秒调）。

**B2. 登录自启（不需要提权）**

```powershell
powershell -ExecutionPolicy Bypass -File ci\install-autostart.ps1
powershell -ExecutionPolicy Bypass -File ci\install-autostart.ps1 -Remove
```

写的只是 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `DSHDispatcher`，
命令是 `node --use-system-ca <repo>\ci\dispatch.mjs --ensure`，注册后立即生效一次。

**A 和 B 可以并存**：常驻进程持锁时，计划任务的 `--once` 会静默秒退（实测 119ms，不写日志），
所以不会再出现「每 5 分钟冷启动 + label 索引空转」的噪声。

**`--once` 顺手补位常驻进程**：手动 `--ensure` 起来的常驻进程挂在那次工具调用的进程树上，调用一结束
就可能被回收（2026-10-25 03:15 实测：pid 359480 启动 3 分钟后被下一轮 `--once` 判成陈旧锁接管）。
所以 `--once` 现在先看有没有活着的常驻进程：没有就拉起一个（日志 `拉起常驻调度器（pid=…），本轮交给它轮询`）
再让位；拉不起来才退回单轮执行。由计划任务拉起的常驻进程不在工具进程树里，跨调用存活（实测 pid 307372
跑过 04:40:41 那一轮 `--once` 静默秒退）。

**只读工单（`readonly:ok`）**

查询、审计、回答问题这类工单本来就不该产生改动，但它们和「必须有改动」的门禁互斥，所以给一个显式出口：

- issue 打 `readonly:ok` 后，提示词会多一段「只读任务」：结论写进最终回答，不许建临时脚本或 wrapper；
- 跑完零改动 → 结论贴成 issue 评论、打 `agent:done`、**不开 PR**；
- 跑完却有改动 → 视为违约中止并进记忆库（`[readonly] 只读工单产生了文件改动`），绝不推分支。

**双实例抢锁（谁在跑、谁让位）**

三种起法（计划任务 `--once`、`--ensure` 拉起的常驻、前台 `--serve`）**抢的是同一把锁**：`.logs/dispatch.lock`。
两个进程同时干同一批 worktree 和分支时，agent 会看到别人刚改过的树，表现成「agent 未产生任何改动」这种**假故障**——
所以撞车不是崩溃，而是**谁安静谁让位**，日志正常也会出现接管记录。

- **锁内容**：`{pid, at, mode}`，`mode` 是 `serve`（常驻）或 `once`（跑一轮就退）。
- **陈旧窗口按模式分**（2026-10-28 改）：`serve` 每轮刷心跳，停 `DSH_LOCK_BEAT_STALE_MS`（默认 3 分钟）就判陈旧——
  卡死的常驻不必等 40 分钟；`once` 领到单要干到超时才回来（心跳是停的），沿用 `LOCK_STALE_MS = DSH_TASK_TIMEOUT_MS + 10min`
  （默认 30 + 10 分钟）。老锁文件里没有 `mode` 时按 `once` 处理：宁可多等，也不误杀一个正在跑长任务的进程。
  判据是纯函数（`ci/lock-policy.mjs` 的 `lockHeld()`），有单测。
- **判定顺序**：文件不存在（`wx` 原子创建成功）→ 拿锁；持有者进程还活着（`process.kill(pid, 0)`）且锁龄 < 窗口 → 退出；
  否则按陈旧锁接管，并记一行 `接管陈旧锁（pid=… 起于 …）`。
- **`EPERM` 算活着**：Windows 上跨用户 / 提权的进程，`process.kill(pid, 0)` 抛的是 `EPERM`（进程在、只是没权限发信号），
  `ESRCH` 才是真死。把 `EPERM` 当死会误接管一个 1 分钟前才刷过心跳的常驻进程（2026-10-28 实测踩到，已修）。
- **心跳**：常驻进程每轮把 `at` 刷成现在。没有心跳，一个只是**闲久了**的常驻进程会被别的进程判成陈旧锁接管，
  而它自己还在轮询——两边都以为自己是主人。
- **同时判陈旧**：两个进程可能同时判「陈旧」并各写一份锁；写完必须回头 `ownsLock()` 复核，**输的一方让位**（返回 `{ok:false}`），
  所以抢锁不会出现「两个都以为拿到了」。
- **释放只删自己那份**：`release()` 先确认锁里还是自己的 `pid` 才 `unlink`。无条件删会把**新持有者**的锁删掉，第三个进程再「接管」一次——
  2026-10-25 07:17 实测就是这样滚成「谁都没有锁、也没有常驻进程」。
- **被接管后主动退出**：常驻进程每轮轮询前用 `ownsLock()` 确认锁还是自己的，不是就记 `锁已被接管（pid=… 不再是持有者），常驻进程退出` 并退出。
- **怎么判读日志**：出现 `接管陈旧锁（…）` 或 `锁已被接管（…），常驻进程退出` 属**正常让位**，不是故障；
  真故障信号是「两边都以为自己持锁」（同一批 worktree 同时有两条 `[issue #N] 领取`）。
- **残留工作树巡检**（2026-10-28 加）：启动时看一眼 `WT_ROOT`（默认同级 `.worktrees/`）下的 `issue-<号>` 目录，
  对不上任何 open 工单的记一行 `[worktrees] #N 已无 open 工单，工作树干净：issue-N（可移除：git worktree remove …）`，
  有未提交改动的改成「不自动删，人工确认」。**只报不删**：删会连未提交改动一起丢，这种动作留给人。
  判据在 `ci/worktree-audit.mjs`（纯函数 + 单测），只在启动时跑一次，不进轮询。

三种形态都只做「领取 → 干活 → 推分支 → 开 PR」，**不会自动合 PR**。

> **A 需要提权**：实测本机 DSH 进程是 `zhao\administrator` 但 `elevated: False`，
> `Register-ScheduledTask` 和 `schtasks /Create` 都直接 `Access is denied`（连
> `cmd.exe /c exit 0` 的最小任务都一样）。所以 `install-task.ps1` 必须在**提权的**
> PowerShell 里跑一次：右键「以管理员身份运行」→
> `powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\ci\install-task.ps1`
>
> 而 B2（HKCU Run）不需要提权，是默认推荐路径。

## 语义评审：两个模型组成的评审团（2026-10-26）

单模型语义评审有一个结构性弱点：它和写代码的 agent 常常是同一家族、同一种盲区，
「代码看着像那么回事但没满足验收」这种错，一个模型看不见时另一个也看不见。

现在 push 之前跑的是**评审团**（`ci/semantic-review.mjs` 的 `reviewWithPanel`）：

| 项 | 值 |
| --- | --- |
| 默认成员 | `Qwen/Qwen3.5-122B-A10B`、`moonshotai/Kimi-K2.7-Code`（不同家族） |
| 覆盖方式 | `DSH_REVIEW_MODELS="a,b,c"`（逗号分隔，全部走 siliconflow） |
| 执行方式 | 并行（`Promise.all`），各自独立读同一份 diff 与验收标准 |
| 聚合规则 | 任一模型 block → block；至少一个真的跑过且都 pass → pass；全部 skipped → skipped |
| 失败原因 | 阻断时把**所有**评审器的问题一起回灌给下一次重试 |
| 实测耗时 | 最后一次真实 diff：**15s**（两个模型并行；单模型时期是 51–61s 串行） |

边界（如实说明）：两个模型都跑不起来时（无凭证/超时）这层是 skipped，只在日志留
`⚠ 语义评审未执行（这一层等于没有）`；评审团不能替代可执行的验收命令——
`### 验收命令` + `VERDICT: PASS/FAIL` 才是硬裁决，评审团只补「验收标准解读」这一类判断。

## 评审层（push 之前拦）

两层都在 commit 之后、push 之前跑；任何一层 block 都不推送，失败原因写进记忆库并自动重试。

**机械规则**（`ci/review.mjs`，只看 diff 的形状）

| 规则 | 级别 | 触发 |
|---|---|---|
| `forbidden-path` | block | 改动 `.github/workflows/` |
| `debug-residue` | block | 新增 `BROKEN`、`debugger`、冲突标记、`.only(`、`TODO(agent)` |
| `test-removed` / `assert-removed` | block | 测试文件里删掉了 `test(` / `it(` / `assert.` 行 |
| `baseline-unsynced` | block | 改了 `src|ci` 的测试文件但两个基线文件都没动 |
| `dependency-added` | block | `package.json` 新增依赖 |
| `no-file-change` | block | 提交里一个文件都没变（agent 曾造空提交绕过「必须有改动」） |
| `gate-modified` | block/warn | 改了门禁脚本本身（`verify.sh`/`assert-guard.mjs`/`dispatch.mjs`/`review.mjs`）；issue 打 `allow:gate` 降为提示 |
| `diff-large` | warn | diff 超过 400 行 |

**语义规则**（`ci/semantic-review.mjs`，让另一个家族的模型读验收标准 + 实际 diff）

机械规则看不出「代码写得像那么回事、但根本没满足验收」——只实现示例里的那一种输入、把断言写得比需求弱、
要求抛 `RangeError` 却返回 `undefined`。所以 push 之前把 issue 的「验收标准 + 约束 + `git diff`」交给
`Qwen/Qwen3.5-122B-A10B`（`DSH_REVIEW_MODEL` 可改），只要它输出
`{"verdict":"block","findings":[…]}` 就中止并重试。

- 判定口径写死在提示词里：能**指名**某条验收没满足 / 改弱了已有断言 / 与需求文字直接矛盾才 block，
  风格问题只 warn——避免它变成风格警察。
- 提示词里除了 diff，还给两样证据：`git diff --name-status` 的**改动文件清单**，以及调度器**已经跑过的
  验收命令**。原因见下节的两个误判。
- 解析失败一律按 block（fail closed）：模型话说一半不能混成「通过」。
- 评审模型超时、网络失败、没有凭证 → `skipped`，只记日志不阻断（评审层不该让流水线停摆）；
  skipped 会单独打一行 `⚠ 语义评审未执行（这一层等于没有）`，因为它等于这层不存在。
- 超时默认 240s（`DSH_REVIEW_TIMEOUT_MS`）。原来 120s，实测 `Qwen/Qwen3.5-122B-A10B` 常态跑不完，
  两次都是 `This operation was aborted` → skipped，等于白挂一层。
- `DSH_REVIEW_MOCK=<file>` 用文件内容代替模型输出，用于端到端验证 block 路径而不花钱。
- 结论会写进 PR 的「## 自动检查」段，block 时的意见同时作为下一次重试的「上次失败原因」。

**两次真误判（都改了提示词，不是改判据放宽）**

1. `#48` 要求「为 cube 补断言」，而 `cube` 早在 `9b53a3d` 就随 `square` 一起合入了——这次只该改测试。
   评审模型看到 diff 里没有 `src/index.js`，判 block：`cube(3) === 27 ... cannot be verified because
   src/index.js is not modified`。**修法**：给出改动文件清单，并在口径里写明「需求可能已经被之前的合并
   实现了，只要最终代码满足验收就判 pass」。
2. 同一次运行里我还看到它把「实现方式与我预期不同」当理由。**修法**：口径加「引用具体代码时抄 diff 原文，
   不要凭印象描述实现」。

## 验收命令（`### 验收命令`，可执行强约束）

Issue 模板里有一段可选字段：「验收命令」。调度器在机械评审通过后、commit 之前，**自己**在 worktree 里跑一遍：

```bash
node -e '...'        # 多条命令可以换行，整体交给 bash -lc
test -f dist/x.tgz
```

- 任一条非 0 退出 → `验收命令未通过（exit=N）` → 记指纹库（`reason=acceptance command failed`）+ 自动重试。
- 全 0 → 日志 `验收命令通过（N 行）`，PR body 的「自动检查」写明「已通过（N 行，调度器执行）」，
  并把这段命令作为证据一起交给语义评审。
- 为什么需要它：agent 自己写的测试可以「自证」——断言写得比需求弱，或者只覆盖示例里的那一种输入。
  这一段是**人给的、agent 改不动的**判据。

## 合并冲突自动 rebase

两个 agent PR 改同一个文件时，先合并的那个会让后一个变成 `mergeable_state=dirty`，CI 修不了（推送前就 405）。

`checkAgentPRs()` 每轮对 open PR 取一次详情，`mergeable_state === 'dirty'` 时调 `rebaseAgentBranch()`：

1. `fetch`（连不上 github.com 时重试 3 次，网络抖动不算「需要人工」）→ 在 `<工作盘>/.worktrees/issue-<n>-rebase`
   上检出 `tmp/rebase-<n>`；
2. `git rebase origin/main`；
3. 干净 → 跑 `verifyWorktree()` 门禁 → `push --force-with-lease origin tmp/rebase-<n>:agent/issue-<n>`，
   评论 `🔄 分支 … 已自动 rebase 到最新 main`；
4. **冲突只落在 `scripts/test-baseline.txt` / `scripts/assert-baseline.txt`** → 不用人：取 main 的版本把 rebase
   走完，再在合并后的测试文件上跑 `verify.sh --bless` 重算基线，amend 进最后一个提交，然后照第 3 步门禁 + 推送
   （`ci/rebase-conflict.mjs` 的 `classifyConflicts()` 做这个分类，单测在 `ci/rebase-conflict.test.mjs`）；
5. 其余任何文件冲突 → `rebase --abort`，列出冲突文件，评论 `⚠️ … 自动 rebase 失败（冲突文件：…）`，
   打 `agent:failed` 转人工。

**为什么单独处理基线**：每个 agent PR 都会改这两个文件（新增测试/断言要同步计数），所以并行 PR 十有八九正好在
它们上面撞车，而「要 88 还是 90」这种冲突有唯一正确答案——合并后的测试文件，重算即可。实测 2026-10-25 10:36：
#55/#54/#50 三个 PR 依次自动重算基线并推送，CI 全绿，无人工介入；同批 #51 因 github.com 连不上没跑完。

两种评论都带 `<!-- auto-rebase:<sha> -->`；同一个 sha 最多试 3 次（工具修好后仍有重试机会，又不会每分钟空转）。

## 日志保留

`.logs/` 里每次尝试都落 `issue-<n>-attempt-<m>.log` 与 `.prompt.md`，无人值守跑几天就是几千个文件。

- 启动时 `pruneLogs()` 删除超过 `DSH_LOG_RETENTION_DAYS`（默认 7 天）的尝试日志；
- 只匹配 `issue-<n>-attempt-<m>.(log|prompt.md)`，别的文件（锁、`dispatch.log.1`、手工放的）一律不碰；
- 实际删了会打一行 `清理 N 个超过 7 天的尝试日志`。

## 失败指纹库（`docs/failures.jsonl`）

每次失败都记一条 JSONL：`{fp, sig, issue, attempt, reason, fix, at}`。

- `signature()` 先规范化（抹掉时间戳、耗时、绝对路径、`issue #N`、`exit=<n>`、`Error:` 前缀），
  再取第一行「真症状」——首行是 `exit code 1` 这种空壳子时往下找第一行有信息量的，
  最后拼上命中的规则名（`rules=[baseline-unsynced]`）。
- 同一个根因不同尾巴会合并成同一个 `fp`，不同规则不会（实测：门禁红被拆成 6 个指纹 → 归并成 1 个）。
- 重试时把「同一个根因出现过 N 次…上次现象/上次修法」注入提示词，让新的一次不必重踩。
- `node ci/failures.mjs show` 看当前指纹分布，`node ci/failures.mjs repair` 按新算法重算历史记录。

## 无人值守的两个出口（2026-10-26）

调度器跑完一条工单后只有两条去向，由 issue 上的标签决定：

| 标签 | 到达条件 | 调度器做什么 |
| --- | --- | --- |
| （默认） | CI 绿、分支可合并 | 只在日志里记 `等人工合并`，PR 留给人工点合并 |
| `merge:auto` | CI 绿、`mergeable_state=clean` | squash 合并、评论、删分支、关 issue |

产品调研（`docs/research/products.md`）里没有任何一家把合并交给 agent，所以默认仍然停手；
`merge:auto` 是显式的逐单授权，不是全局开关。打 tag / 发版永远人工。

每份工单在工作区里还有一份 `.dsh/PLAN.md`（目标 / 验收标准 / 验收命令 / 约束 / 红线），
由调度器按 issue 生成、已排除在提交之外；agent 与评审层看的是同一份。

## 记忆回流到 Hindsight（`ci/distill-failures.mjs`）

指纹库只在「本机这个仓库」里滚，换一台机器就重新踩同样的坑。`ci/distill-failures.mjs` 把
`docs/failures.jsonl` 归并成一份摘要（出现次数最多的 N 条根因 + 修法 + 相关工单，调用栈已剪掉），
写进 Hindsight 的独立 bank `pipeline::failures`，三台机器都能 recall 到。

```
node ci/distill-failures.mjs --dry            # 只看摘要，不写
node ci/distill-failures.mjs                  # 写入 Hindsight（默认 bank pipeline::failures）
node ci/distill-failures.mjs --bank some::bank --top 20
```

凭证从 `~/.hindsight/coding-agent.json` 读（apiUrl / apiToken），不落到仓库里。
实测 2026-10-26：摘要含 14 个根因，写入返回 `status=200`，bank 列表里出现 `pipeline::failures`。

## 发版（`ci/release.sh`）

发版是唯一「人说了算、但步骤机械」的动作，写成脚本就不会漏跑门禁或把 tag 打在没验证的提交上：

```
bash ci/release.sh patch           # 0.1.0 -> 0.1.1，只在本地产出提交与 tag
bash ci/release.sh patch --push    # 顺带推送 main + tag，触发 release.yml 生成 Release
bash ci/release.sh minor --push    # 0.1.1 -> 0.2.0
```

步骤固定为：工作区必须干净 → 跑 `scripts/verify.sh` → 改 `package.json` 版本 → 提交 `Release vX.Y.Z`
→ 打 annotated tag → （加 `--push` 时）退避重试推送并打印 Release 链接。

## 评审的免费优先与付费告知（2026-10-26）

语义评审按「免费优先」跑，规则写在 `ci/semantic-review.mjs` 的 `reviewWithPanel`：

1. 先用免费档模型 `XingChenAGI/Xing4.0-29B`（`FREE_REVIEW_MODEL`，账号免费额度内）单独评审。
   拿到合法 `verdict` 就结束——这一单的语义评审不花钱。
2. 免费档**给不出裁决**才切付费面板（默认 `Qwen/Qwen3.5-122B-A10B` + `moonshotai/Kimi-K2.7-Code`）。
   「给不出裁决」包括：没有凭证、HTTP 4xx/5xx、超时、以及**没按格式回 JSON**（29B 实测会这样）。
3. 一旦切了付费，三处同时留痕：`dispatch.log` 的 `⚠ 语义评审切到付费面板（免费模型 … 不可用：原因）`、
   issue 上的评论（写明免费档模型、原因、实际用了哪些付费模型）、PR body 的「语义评审」行标注 `⚠ 免费模型不可用，已切付费`。
   `formatSemantic` 的结果里也带 `[付费]` 前缀。

可调环境变量：

| 变量 | 作用 |
| --- | --- |
| `DSH_REVIEW_FREE_MODEL` | 换免费档模型（默认 `XingChenAGI/Xing4.0-29B`） |
| `DSH_REVIEW_MODELS` | 覆盖付费面板成员（逗号分隔） |
| `DSH_REVIEW_SKIP_FREE=1` | 直接走付费面板，不走免费档（急需强判断时用） |
| `DSH_REVIEW_TIMEOUT_MS` | 单次评审超时（默认 240000） |

实测（2026-10-26）：免费档对同一 diff 回了「分析 + 没有 JSON 结论」→ 触发升级 → 付费面板 Qwen+Kimi 在 43 秒内给出
两条具体 block（点名验收里要求的文件没改、约束被违反）。免费档 3037 tokens、34 秒。

## 设计院层：规格 → 任务分解 → 建单（2026-10-27）

小切片用 issue 就够；一个系统（多个模块、跨文件、要并行）先写规格，再拆任务，别让 agent 猜。

1. 复制模板：`docs/specs/_template/{spec,design,tasks}.md` + `contracts/README.md` 到 `docs/specs/<slug>/`。
2. 填 `tasks.md` 的表格（任务 / 说明 / 依赖 / 验收命令），验收命令必须自己打印 `VERDICT: PASS`。
3. 预览：`node ci/plan.mjs <slug> --graph`（依赖分层 + mermaid）；`node ci/plan.mjs <slug> --dry`（会建哪些单）。
4. 真建：`node ci/plan.mjs <slug> --create` → 每个任务一张 issue，依赖变成 `dep-on:T1` 标签。
5. 调度器只在前置 issue 关闭后开工（日志 `[dep] #N 在等 T1 关闭，本轮跳过`）。
6. 跨切片验收：`docs/specs/<slug>/integration.md` 里写 bash 代码块，`bash scripts/integration.sh <slug>` 逐块执行。

现成样例：`docs/specs/ledger/`（记账小工具，T1→T2a/T2b→T3；实测 #76~#84 全部合并，集成验收 `VERDICT: PASS`）。复制 `docs/specs/_template/` 写自己的规格，不要改样例本身。

## 免费池不可用时挂起而不是烧钱（2026-10-27 定）

免费池模型额度耗尽（`insufficient balance`）或连续 2 次 0 token 时，**默认不切付费**：

| 步骤 | 行为 |
|---|---|
| 判定 | `ci/pool-block.mjs` 的 `freePoolDecision()`：文本命中 `QUOTA/insufficient balance/余额不足/无可用模型`，或连续 `zeroTries >= 2` 次 0 token |
| 处置 | 摘 `agent:ready`/`agent:working`、打 `agent:blocked`、评论区贴失败尾部与恢复办法（含「大部分情况不用管，会自动重投」） |
| 人工放行 | 打 `model:paid` 再打 `agent:ready` → 该单走 `deepseek-flash` |
| 恢复旧行为 | 调度器环境变量 `DSH_FREE_POOL_BLOCK=0` → 自动切付费（会花钱，慎重） |
| 留痕 | `dispatch.log` 一行 `[issue #N] 免费池不可用（…），工单挂起为 agent:blocked（不自动烧付费）`；失败指纹同时入 `docs/failures.jsonl`；本地状态写 `.logs/blocked-state.json` |

设计理由：模型额度是**环境状态**，不是「这单写错了」；环境坏了还继续跑，只会用付费把钱烧在一个本来免费的任务上。判据与动作分开（纯函数 + 网络调用），单测在 `ci/pool-block.test.mjs`。

### 挂起之后：自动恢复（2026-10-28）

挂起本来是「等人」，无人值守时有个死角：池子半夜恢复了，单子还躺在 `agent:blocked` 里。现在补一层自动恢复：

| 项 | 口径 |
|---|---|
| 判据来源 | `ci/blocked-recovery.mjs`（纯函数 + `ci/blocked-recovery.test.mjs` 9 个单测），网络动作只在 `dispatch.mjs` 的 `recoverBlocked()` |
| 探活节奏 | 退避 5 / 10 / 20 / 40 / 60 分钟，之后固定每小时一次；`DSH_BLOCKED_BACKOFF_MIN=5,10` 可改 |
| 「恢复了」的判据 | `fm.py stats` 里**至少一个 `ok` 模型**；`stale` 不算（要重试/换档）、`degraded`/`unknown`/`down` 都不算——宁可多等一轮，也不白跑一次任务 |
| 探活缓存 | 一轮里挂了好几张单只跑一次 `fm.py`（`DSH_BLOCKED_PROBE_TTL_MS`，默认 60 秒） |
| 恢复动作 | 摘 `agent:blocked` → 打 `agent:ready` → 评论「自动重投第 N 次」；下一轮 `pollOnce()` 就会领到它 |
| 重投上限 | 同一张单最多自动重投 3 次（`DSH_BLOCKED_MAX_REQUEUE`）；次数用完 → 打 `agent:blocked:manual` + 评论「怎么接手」，不再自动投 |
| 计数为什么要跨次继承 | `blockTask()` 重新挂起时继承 `requeues`，否则「池子抖一下 → 重投 → 立刻又挂 → 再重投」会无限循环 |
| 老单子怎么办 | 本代进程第一次见到的 `agent:blocked`（上一代挂的 / 手动打的）从此刻开始计时，不继承旧计数 |
| 状态文件 | `.logs/blocked-state.json`（原子写：写 `.tmp` 再 rename）；7 天没动过的条目自动清 |
| 日志判读 | `[blocked] #N 已挂起但没有本地记录，从现在开始计时` / `[blocked] #N 免费池仍不可用（…）` / `[blocked] #N 免费池恢复（3/103 个模型 ok），自动重投 agent:ready（第 1/3 次）` / `[blocked] #N …停止自动恢复` |
| 关掉 | `DSH_BLOCKED_AUTO_REQUEUE=0`（回到「只挂起、等人工」） |
| dry-run | 只打印 `[dry-run] [blocked] #N would requeue：…`，不改标签、不写状态 |

## 成本计量与预算闸（2026-10-27）

- 每次 headless 的 token 用量写 `.logs/usage.jsonl`，按 DeepSeek 官方价目表折成人民币（`ci/prices.mjs`；免费池记 ¥0）。
- 缓存命中量 DSH 没透出，输入一律按「未命中」计 → 金额偏高、保守。
- 单任务超过 `DSH_TASK_MAX_CNY`（默认 0.5 元）→ 日志告警并暂停本批次新任务；当日累计超过 `DSH_DAY_MAX_CNY`（默认 5 元）→ 当天不再领取。
- 切付费评审只在估算超过 `DSH_NOTIFY_CNY`（默认 0.05 元）时才写 issue 评论，否则只进日志与 PR body。
- 每日（本地 7 点后）自动跑 `ci/distill-failures.mjs` 与 `ci/cost-report.mjs`，产出 `.logs/cost-report.md`（2026-10-28 起不再写 `docs/`：每天自动生成会把工作树弄脏，而 `ci/land.sh` 曾经是 `git add -A`，报表会混进不相关的提交）。

## 事件通知（2026-10-28）

无人值守最容易出的事不是「跑错」，是**跑挂了没人知道**。所以三类事件会主动推出来：

| 事件 | 什么时候 | 记录 |
|---|---|---|
| `failed` | 任务重试用完被标 `agent:failed` | issue 评论 + 日志 + 事件 |
| `blocked-manual` | 重投次数用完，打了 `agent:blocked:manual`，真的需要人 | issue 评论 + 日志 + 事件 |
| `daycap` | 当日估算花费到 `DSH_DAY_MAX_CNY`，今天不再领新任务 | 日志 + 事件（一天只弹一次） |

- 落盘：`~/.dsh/coord/log/events.jsonl`，一行一条，字段 `at / kind / issue / why / cny`（`why` 截 300 字符）。digest 每天读它出摘要；`DSH_EVENTS_LOG` 可改路径。
- 弹窗：Windows Toast，标题 `流水线 #N 任务失败` 之类；脚本 `.logs/notify-toast.ps1` 每次重写（UTF-8 带 BOM——PS 5.1 没 BOM 会把中文按 GBK 解，见 `PITFALLS.md` P1）。
- 弹窗是 best-effort：`powershell` 起不来、超时 15 秒、没有通知通道，都只记一行 `[notify] 弹窗失败（不影响任务）：…`，任务照跑。
- 关掉：`DSH_NOTIFY=0`（只落事件、不弹窗）；`--dry-run` 下完全不发。

## 免费池探活（`--probe-stale`，2026-10-28）

`fm.py stats` 里 `stale` 不是坏，是「上次失败过、还没再试」；而强档选型只看 `ok`。所以给一条手动命令：

```bash
node ci/dispatch.mjs --probe-stale            # 探最多 8 个（DSH_PROBE_LIMIT 可调）
node ci/dispatch.mjs --probe-stale --dry-run  # 只打印会探哪几个
```

- 挑谁：`stale` 优先，其次 `unknown`（从没测过），同状态按 id 排序——同一份快照每次挑同一批，便于对照；`ok`/`degraded`/`down` 不浪费探活时间。
- 怎么探：调 `probe.py --only <id,id,…> --quiet`（其余模型沿用上次结果），超时 `DSH_PROBE_TIMEOUT_MS`（默认 15 分钟）。
- 日志：`[probe] 探活 N 个 stale/unknown 模型：…` → `[probe] 汇总：6 个模型，可用 3，失败 0…` → `[probe] 探活后：95/158 个模型 ok`。
- **为什么不进轮询**：探活要连网、要几分钟，放在轮询里会让每轮变慢；池子掉了有挂起 + 自动重投兜着，探活是「人想让池子更好用」时才做的事。

## 同账号多库（`--repos repos.json`，2026-10-28）

一个账号下接管多个仓库时，**不要**在一个进程里轮询多个库：锁、日志、worktree 全是模块级状态，串起来会互相删标签。做成「每库一个自己的常驻」：

```json
[
  { "repo": "Satan1982/dsh-pipeline-demo", "dir": "D:/code/dsh-pipeline-demo" },
  { "repo": "Satan1982/other-repo",        "dir": "D:/code/other-repo" }
]
```

```bash
node ci/dispatch.mjs --repos repos.json     # 逐库跑一次 --ensure（已在跑的就报 pid，不重复拉）
```

- 子进程只多三个环境变量：`DSH_REPO` / `DSH_LOG_DIR=<dir>/.logs` / `DSH_WORKTREES=<dir>/.worktrees`，外加 `DSH_REPOS_CHILD=1` 防套娃；**单库路径一行没改**。
- 隔离因此是真的：每库自己的 `dispatch.lock`、`dispatch.log`、`blocked-state.json`、工作树目录；两个库不可能互相接管锁。
- 清单写错（`owner/name` 格式、重复、目录不存在）逐条报 `[repos] 跳过 …` / `[repos] … 的目录不存在`，有失败退出码 1；没写 `dir` 就用仓库名当目录（相对清单所在目录）。
- 代价：N 个库 = N 个进程，各自每 60 秒轮询一次；按需加减，不要为「以后可能」常开。

