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
所以不会再出现「每 5 分钟冷启动 + label 索引空转」的噪声；常驻进程挂了，下一轮 `--once` 会接管。

**锁与接管**

- `.logs/dispatch.lock` 里是 `{pid, at}`；判定顺序：文件不存在 → 拿锁；持有者进程活着且锁龄 < `TIMEOUT + 10min` → 退出；否则按陈旧锁接管并记一行日志。
- 常驻进程每轮轮询前用 `ownsLock()` 确认锁还是自己的，被别人接管就主动退出——否则卡死超过判定窗口后会变成两个调度器抢同一批 worktree。

三种形态都只做「领取 → 干活 → 推分支 → 开 PR」，**不会自动合 PR**。

> **A 需要提权**：实测本机 DSH 进程是 `zhao\administrator` 但 `elevated: False`，
> `Register-ScheduledTask` 和 `schtasks /Create` 都直接 `Access is denied`（连
> `cmd.exe /c exit 0` 的最小任务都一样）。所以 `install-task.ps1` 必须在**提权的**
> PowerShell 里跑一次：右键「以管理员身份运行」→
> `powershell -NoProfile -ExecutionPolicy Bypass -File D:\code\dsh-pipeline-demo\ci\install-task.ps1`
>
> 而 B2（HKCU Run）不需要提权，是默认推荐路径。
