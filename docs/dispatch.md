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

## 已知限制

- **串行执行**：一次处理一个 issue。并发要改造成 worktree 池 + 并发槽位。
- **label 索引延迟**：刚创建的 issue 立刻跑 `--once` 可能查不到（实测间隔约 10s）。
- **CI 失败不回环**：agent 在 worktree 里自己跑 `verify.sh` 通过了，如果云端 CI 因环境差异红了（Node 版本等），调度器不会自动重试，要人重新打 label。
- **模型能力上限**：当前 siliconflow/Xing4.0-29B，小改动干净，复杂需求需要换更强模型或人工拆小。
- **Node 证书**：脚本会自动用 `--use-system-ca` 重启自己，否则 api.github.com 报 `unable to verify the first certificate`。
