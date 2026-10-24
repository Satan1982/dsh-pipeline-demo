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
C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe
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
4. **隔离 worktree**：任务在 `D:/code/.worktrees/issue-<N>` 执行，主工作区不受影响。

## label 约定

| label | 含义 |
|---|---|
| `agent:ready` | 提交通道，调度器会领取 |
| `agent:working` | 正在执行（防止重复领取） |
| `agent:done` | 已产出 PR |
| `agent:failed` | 执行失败，需人工处理后重新打 `agent:ready` 重试（先去掉 `agent:failed`） |

Issue 模板：`.github/ISSUE_TEMPLATE/agent-task.yml`，新建 issue 时选「自动化任务」自动带上 `agent:ready`。

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
`D:/code/.worktrees/issue-<N>` 和独立分支 `agent/issue-<N>`，互不干扰。

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
`D:/code/.secrets/headless-model-strong.yml`，改用 `deepseek-ai/DeepSeek-V4.1-Flash`。

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
`D:\code\.secrets\github-token.txt` 读，不写进任务定义。

**B. 当前终端常驻**

```bash
node --use-system-ca ci/dispatch.mjs
```

默认每 60 秒一轮（`DSH_POLL_INTERVAL` 按秒调），Ctrl+C 停。

两种形态都只做「领取 → 干活 → 推分支 → 开 PR」，**不会自动合 PR**。

> **A 需要提权**：实测本机 DSH 进程是 `zhao\administrator` 但 `elevated: False`，
> `Register-ScheduledTask` 和 `schtasks /Create` 都直接 `Access is denied`（连
> `cmd.exe /c exit 0` 的最小任务都一样）。所以 `install-task.ps1` 必须在**提权的**
> PowerShell 里跑一次：右键「以管理员身份运行」→
> `powershell -NoProfile -ExecutionPolicy Bypass -File D:\code\dsh-pipeline-demo\ci\install-task.ps1`
>
> 在那之前只有 B 可用——DSH 一关，调度器就停。

> 计划任务里的 PATH 不含 node/git，所以 `dispatch.mjs` 会把当前 node 与 git 的目录
> 拼进子进程 PATH（`CHILD_PATH`），否则被调起的 agent 在 `verify.sh` 里跑 `node`
> 会 `command not found`。

> 全局 `insteadOf` 规则把 `https://github.com/` 重写成 `ghfast.top` 镜像，而全局
> `credential.helper=manager` 给镜像的凭据是错的：实测走 GCM 时 `git fetch` 3/3 报
> `remote: Repository not found.`，禁用 GCM、只用 `GIT_ASKPASS` 后 3/3 成功（~2s）。
> 因此 `dispatch.mjs` 的所有 git 调用都带 `-c credential.helper=`。

## 已知限制

- **label 索引延迟**：刚创建的 issue 立刻跑 `--once` 可能查不到（实测间隔约 10s）。
- **PR 仍要人合**：并发的是实现阶段，PR 一个一个合；两个 issue 改同一文件会产生冲突，要人裁决。
- **模型能力上限**：29B 对「跨 3 个文件、需要判断改动边界」的任务会漏东西（见上表），复杂需求加 `model:strong` 或人工拆小。
- **Node 证书**：脚本会自动用 `--use-system-ca` 重启自己，否则 api.github.com 报 `unable to verify the first certificate`。
- **无失败指纹库**：同一类失败第三次重试还是从头试，没有跨 issue 的历史教训（Hindsight 里可以补，尚未接）。

## 评审层（push 之前拦）

`ci/review.mjs` 在调度器 push 之前看 diff，判定「这不该被推上去」。它不做审美判断，只做机械判定：

| 规则 | 级别 | 挡的是什么 |
|---|---|---|
| `forbidden-path` | block | 改 `.github/workflows/*` |
| `debug-residue` | block | `BROKEN`、`debugger`、冲突标记、`.only`、调试日志 |
| `test-removed` / `assert-removed` | block | 删用例、删断言（比等 CI 红更早一步） |
| `baseline-unsynced` | block | 改了测试却没 `--bless`（PR #22 就是这么混过去的） |
| `dependency-added` | block | 新增依赖未人工批准 |
| `gate-modified` | block | 动了门禁脚本（`verify.sh` / `assert-guard.mjs` / `ci/dispatch.mjs` / `ci/review.mjs`）；确需改动时在 issue 打 `allow:gate` label，降为提示 |
| `diff-large` | warn | 单次新增 > 400 行 |

同时 `runTask` 不再采信 agent 的自述：headless 结束后调度器自己在同一 worktree 里跑一遍
`bash scripts/verify.sh`，红了直接重试。两者顺序是 独立门禁 → commit → 评审 → push。

手动跑：`node ci/review.mjs`（默认对比 `origin/main`）。

## 失败指纹库

`docs/failures.jsonl` 是追加写的失败账本，每条记录：

```
{"fp":"指纹前16位","sig":"症状骨架","issue":25,"attempt":1,"reason":"...","fix":"...","at":"..."}
```

- 指纹 = 归一化（抹掉 sha、时间、耗时、绝对路径）后的签名哈希，同类错误换张工单也是同一指纹。
- 命中同指纹时，调度器把「上次根因 + 上次修法」直接插进 prompt。
- 指纹不同但同一工单反复失败 = 在瞎试，这个信号人工看日志时一眼可见。

## 可靠性补丁（2026-10-25 实测）

| 故障 | 现象 | 修法 |
|---|---|---|
| 两个调度器并发 | 计划任务每 5 分钟一轮，手动 `--once` 撞上去，两个进程抢同一 worktree 与分支，互相 `worktree remove --force`，外部表现是「agent 未产生任何改动」这种假故障 | `.logs/dispatch.lock` 单实例锁（`writeFileSync(...,{flag:'wx'})` + pid 存活探测 + 超时接管），第二个进程打一行日志后直接退出 |
| `BUNDLE_DIR` 拼错 | `node/bin/node.exe` 只上溯两级落到 `dependencies/node`，`PNPM_CLI` 指向不存在的文件，门禁打包步骤必挂 | 上溯三级到 `dependencies`；`verify.sh` 遇到不存在的 `PNPM_CLI` 直接报路径，不再让 node 抛 `MODULE_NOT_FOUND` |
| 29B 模型撞 TPM | 长推理任务跑一半 `RATE_LIMIT: 429 {"code":50602,"message":"... TPM limit reached"}`，agent 停在「Now I'll add ...」不再动手，退出码 0 或 1 都可能是这个原因 | 这类任务挂 `model:strong`（DeepSeek-V4.1-Flash），实测 #27 同题 29B 三次全废、strong 一次成 |

排障落盘物（都在 `.logs/`，已 gitignore）：
- `dispatch.log`：调度器自身日志，>5MB 轮转为 `.1`
- `issue-<n>-attempt-<m>.log`：该次 headless 的完整 stdout/stderr
- `issue-<n>-attempt-<m>.prompt.md`：该次实际喂给 agent 的提示词，用来确认记忆库/上一轮失败原因有没有真的注入

## 模型路由

| 情况 | 走哪个模型 |
|---|---|
| 第一次尝试 | 默认 29B（免费、便宜） |
| 第 2 次及以后（重试升级） | `DeepSeek-V4.1-Flash`，日志里标 `model=strong(重试升级)` |
| issue 带 `model:strong` | 第一次就用强模型 |

理由：29B 在长推理任务上会撞 TPM 限流（`429 code 50602`）停在「Now I'll add ...」不动，
让同一个弱模型重试三次没有意义；第二次直接换模型，实测 issue #33 第 2 次 45s 成功。
