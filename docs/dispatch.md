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

## 已知限制

- **label 索引延迟**：刚创建的 issue 立刻跑 `--once` 可能查不到（实测间隔约 10s）。
- **PR 仍要人合**：并发的是实现阶段，PR 一个一个合；两个 issue 改同一文件会产生冲突，要人裁决。
- **模型能力上限**：29B 对「跨 3 个文件、需要判断改动边界」的任务会漏东西（见上表），复杂需求加 `model:strong` 或人工拆小。
- **Node 证书**：脚本会自动用 `--use-system-ca` 重启自己，否则 api.github.com 报 `unable to verify the first certificate`。
- **无失败指纹库**：同一类失败第三次重试还是从头试，没有跨 issue 的历史教训（Hindsight 里可以补，尚未接）。
