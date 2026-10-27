# 这套「自动化 AI 编程流水线」是怎么搭的

一句话：**人只写 issue（目标 + 可执行验收 + 约束），机器人在隔离 worktree 里写代码，三道门禁
（可执行验收、机械规则、语义评审团）都过了才开 PR；要不要合并由 issue 上的一个 label 决定。**

代码全部在 `<repo>`，零运行时依赖（只用 Node 标准库 + git + bash）。

## 全景

```
                 ┌──────────── GitHub（唯一的状态源）────────────┐
 人写 issue ───▶ │ issue: 目标 / 验收标准 / 验收命令 / 约束       │
                 │ labels: agent:ready model:strong verdict:strict merge:auto │
                 │ PR: 分支 agent/issue-N、CI 结果、评论          │
                 └───────────────────┬─────────────────────────┘
                                     │ REST（建单/评论/打标/合并）
                      ┌──────────────▼───────────────┐
                      │  ci/dispatch.mjs（常驻调度器）│
                      │  单实例锁 + 60s 轮询 + 并发 2 │
                      └──┬─────────┬─────────┬───────┘
                         │         │         │
            建 worktree   │         │         │  独立跑门禁
        <工作盘>/.worktrees/issue-N  │         │
                         │         │         │
                 ┌───────▼──────┐  │  ┌──────▼────────┐
                 │ headless agent│  │  │ scripts/verify.sh │
                 │ (dsh headless)│  │  │ tests+基线+断言   │
                 └───────┬──────┘  │  └──────────────────┘
                         │ 写代码   │
                 ┌───────▼──────────▼───────┐
                 │ 机械评审 review.mjs       │──┐
                 │ 语义评审 semantic-review  │  │ 任一不过 → 记失败指纹 → 重试
                 └───────┬───────────────────┘  │
                         │ 全过                  │
                 ┌───────▼────────┐              │
                 │ push 分支 → PR │              │
                 └───────┬────────┘              │
                         │ CI                   │
                 ┌───────▼────────────┐         │
                 │ 绿了？merge:auto？ │─────────┘
                 └───────┬────────────┘
                         │ 是
                    squash 合并 → 关 issue
```

## 组件与职责

| 文件 | 职责 | 关键实现 |
| --- | --- | --- |
| `ci/dispatch.mjs` | 调度器：轮询 issue、起 worktree、调 agent、跑门禁、推 PR、处理 CI 失败与冲突 | 单实例锁 + 心跳、并发池、退避重试（fetch/push/SSH 兜底）、重试预算、`merge:auto` 出口 |
| `ci/pool-block.mjs` | 免费池不可用（额度耗尽 / 连续 2 次 0 token）时的处置判定：把工单挂起等人决定，**不自动烧付费** | 纯函数、可单测：`freePoolDecision()` → `none`/`block`/`paid`，`blockReason()` 生成挂起原因；网络与 GitHub 动作留在 `dispatch.mjs`；`DSH_FREE_POOL_BLOCK=0` 退回旧行为 |
| `ci/blocked-recovery.mjs` | `agent:blocked` 之后的自动恢复判据：按退避探活免费池，池子恢复就把工单放回 `agent:ready`；重投有上限，池子抖动不会无限重跑 | 纯函数、可单测：`backoffMs()`（默认 5/10/20/40/60 分钟）、`recoveryDecision()` → `skip`/`wait`/`requeue`/`giveup`、`pruneState()`（7 天没动过的条目自动清）；网络动作留在 `dispatch.mjs`；`DSH_BLOCKED_AUTO_REQUEUE=0` 关掉 |
| `ci/prices.mjs` | 人民币价目表 + 成本闸：每次调用折算成钱，超单任务 / 单日上限就停止领取新任务 | 元 / 百万 tokens；工作日 9:00–12:00、14:00–18:00 高峰双倍、其余半价；免费池模型记 0；`costCny` / `formatCny` / `isPeak` |
| `ci/labels.mjs` | 调度器需要的仓库标签清单与差集判据：启动时把缺的标签补齐，避免「打标签静默丢弃」 | 纯函数、可单测：`REQUIRED_LABELS`（14 个）、`missingLabels(existing)`（忽略大小写/空格，保序）、`labelPayload()`（带颜色与说明）、`formatLabelList()`；网络动作留在 `dispatch.mjs` 的 `ensureLabels()`，失败只记一行日志；`dep-on:*` 不纳入 |
| `ci/headless-task.sh` | 无头执行入口：给 agent 准备 PATH / 模型路由 / 权限档 | 挂 `--patch headless-model.yml`，`DSH_PERMISSION_MODE=danger-full-access`（无人值守不能卡审批） |
| `scripts/verify.sh` | 唯一门禁：lint → 测试 → 测试数基线 → 断言内容指纹 → build → pack | 数字降了就红，新增必须同 PR `--bless` |
| `ci/review.mjs` | 机械评审：只看 diff 形状 | `debug-residue` / `test-removed` / `baseline-unsynced` / `no-file-change` / `gate-modified` 等 |
| `ci/semantic-review.mjs` | 语义评审团：两个不同家族模型并行判「有没有真的满足验收」 | 任一 block 即 block；`DSH_REVIEW_MODELS` 可换；拿不到凭证就 skipped 并告警 |
| `ci/verdict.mjs` | 验收裁决：读验收命令输出里的 `VERDICT: PASS/FAIL` | 裁决不能盖过退出码；`verdict:strict` 时缺裁决即失败 |
| `ci/failures.mjs` | 失败记忆：错误指纹 → 下次重试前回灌「同类失败上次怎么修的」 | 指纹按症状归一，容量上限 500 行 |
| `ci/distill-failures.mjs` | 把本地失败库蒸馏进 Hindsight（跨机器共享） | 独立 bank `pipeline::failures` |
| `ci/rebase-conflict.mjs` | 冲突分类：只有基线文件冲突 → 自动重算；涉及源码 → 交给 agent 解 | 解不动就转人工，不硬来 |
| `ci/precommit.mjs` + `.githooks/pre-commit` | 红线执行层：把「不许删测试 / 不许留调试残留」变成提交时就会失败的钩子 | 与 push 前评审同一套规则，`--no-verify` 才能绕过 |
| `ci/release.sh` | 发版：verify → 升版本 → commit → tag → 推 → Release workflow | 人敲命令才发，不在无人值守范围内 |
| `ci/install-autostart.ps1` / `install-task.ps1` | 登录自启（HKCU Run）与计划任务兜底 | 计划任务每 5 分钟 `--once` 敲门，发现没常驻就顺手拉起 |

## 一次任务的生命周期（日志里能逐条对上）

1. `[issue #N] 领取` — 打 `agent:working`、摘 `agent:ready`（防重复领取）。
2. 建隔离 worktree `<工作盘>/.worktrees/issue-N`（`git worktree add`，`core.hooksPath=.githooks`）。
3. 写 `.dsh/PLAN.md`（目标/验收/命令/约束/红线），并加进 `info/exclude`——agent 和评审都读它。
4. `headless` 起 agent（默认弱模型，第 2 次起升到 strong；`model:strong` 可强制）。
5. agent 写完 → 调度器不看它自述，**自己**跑 `scripts/verify.sh`。
6. 跑 issue 里的 `### 验收命令`（剥掉围栏），按 `VERDICT` + 退出码裁决。
7. 机械评审（diff 形状）→ 语义评审团（两个模型，并行）。
8. 提交（`agent: issue #N`）→ push 分支（https 退避 → SSH 端兜底）。
9. 开 PR，body 里写清独立门禁、验收裁决、语义评审结论，以及**需要人工确认**的三条。
10. 打 `agent:done`、评论、清 label。
11. PR 的 CI 绿了：有 `merge:auto` 就 squash 合并 + 关 issue；没有就停在这等人。
12. 任一步失败：记失败指纹 → 下一次重试 prompt 里带上「同类失败上次怎么修的」→ 3 次用完转 `agent:failed`。

## 门禁的层次（为什么是三层）

- **可执行验收（ground truth）**：exit code + `VERDICT` 行。绕过办法是「写一个能过但不对的实现」——只能靠人写验收解决。
- **机械评审（形状）**：能挡住删测试、改断言、调试残留、越界改 workflows、空提交。
- **语义评审团（意图）**：能挡住「测试绿但没做需求」；默认两个不同家族模型，避免同一盲区。

三层都过才进 PR，但**都不等于「这就是你要的东西」**——所以 PR body 里固定写「需要人工确认」，
合并默认要 `merge:auto`，发版永远人敲。

## 失败与自愈

- 网络：fetch/push 各有退避（~95s / ~55s 窗口），https 判定为网络错误后改走 `ssh.github.com:443`。
- 进程：Windows NTSTATUS（如 `0xC0000142`）识别为「进程没起来」，原地重试 3 次不算 agent 的尝试次数。
- 并发：单实例锁 + 每轮心跳；接管陈旧锁要复核 `pid`，输的一方让位。
- 冲突：基线冲突自动重算；源码冲突交 agent 解一次，失败就 aborted + 评论 + `agent:failed`。
- 可观测：`.logs/dispatch.log`（主日志，>5MB 轮转）、`.logs/issue-N-attempt-M.{log,prompt.md}`、`.logs/issue-N-rebase.log`，保留 7 天。

## 无人值守的边界（刻意不做）

| 动作 | 谁做 |
| --- | --- |
| 写 issue、定验收 | 人 |
| 写代码、跑门禁、开 PR | 机器 |
| 合并 | 只有打了 `merge:auto` 的 issue 由机器合，其余人合 |
| 打 tag / 发版 | 人（`ci/release.sh`） |
| 改 CI/门禁脚本 | 机器会挡住（`gate-modified`），要 `allow:gate` 才放行 |
| 加依赖 | 人（评审会 block） |

## 安全姿态（2026-10-26 核查后）

- 凭据只在 `<secrets 目录>`（不进仓库、不进 git 历史、不进日志——三处都扫过，0 命中）。
- 该目录 ACL 已改为**只允许 `<本机账号>` / `SYSTEM` / `<本机账号>s`**（原来 `Authenticated Users` 有 Modify）。
- agent 子进程的 env 走白名单（`scrubbedEnv()`）：`GIT_TOKEN`、`GIT_ASKPASS`、`SILICONFLOW_API_KEY` 等一律不传。
- 但**agent 与调度器同用户运行**：agent 仍可从磁盘读 `.secrets`。这是当前最大的残余风险，
  根因是「无人值守需要 danger-full-access」。真正隔离要换低权用户跑 agent，属于下一步。
- PAT 仍是 classic（`repo, workflow`，对本账号所有仓库可写）；建议换 fine-grained 单仓库 token。
- 分支保护：私有库免费版 API 返回 403，开不了；即仓库层面没有「禁止直推 main」的强制。

## 经济性

见 `docs/cost-model.md`：GitHub Actions 实测 135 次 run 共 45 分钟；语义评审团单次约 9k tokens
（1 文件 diff），随 diff 线性增长；agent 侧 token 目前无法本地计量（DSH headless 不吐 usage），
只能按 run 时长与模型单价估算。
