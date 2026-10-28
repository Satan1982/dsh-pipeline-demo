# 自动化 AI 编程：现状 / 架构 / 问题 / 下一步

> 评估稿，2026-10-28 16:5x。所有数字都是当场实测（命令见 §6），没有沿用旧文档口径。
> 对象 = `D:\code\dsh-pipeline-demo` 这条流水线，以及它代表的那套「issue → agent → 门禁 → 评审 → PR」做法。

---

## 0. 一句话结论

1. **机制跑通了**：4 天、45 个工单、27 个 PR 合并、累计花费 **¥1.25**，无人值守端到端闭环有实测记录（含「默认停手等人工合并」那条路）。
2. **但它现在给一个玩具干活**：仓库里的 `src/`（1005 行）是 ledger 小工具，是靶子不是产品。被验证的是「流程能转」，**没有被验证的是「转出来的东西有用」**。
3. **今天（10-28）它是闲置的**：0 个新工单、`usage.jsonl` 0 条新记录；今天 19 个提交全是在会话里手工推的（我和另一个并行会话），不是它的 agent 跑出来的。它的产能高峰是 10-27（37 次 CI、37 条失败指纹、27 次计费 run）。
4. 三个结构性缺口：**没有需求来源**（人是唯一入口，人不在就停）、**权限面过大**（agent 与调度器同账号，能读 `.secrets`）、**单机单点 + 通知只到本机**。

---

## 1. 现状（实测）

### 1.1 规模

| 项 | 数字 | 说明 |
|---|---|---|
| 代码 | `ci/ + src/ + scripts/` **7444 行** | `ci/` 6074 · `src/` 1005 · `scripts/` 365（不含基线文本） |
| 其中调度器 | `ci/dispatch.mjs` **2185 行** | 单文件，god-file |
| 文档 | 原有 `docs/` **1786 行** / 10 篇 + 本篇 220 行 | dispatch.md 586、manual.md 225、design 214、architecture 136 |
| 测试 | **30 个测试文件 / 277 个单测 / 572 行断言指纹** | `bash scripts/verify.sh` |
| 依赖 | **0 个** | 纯 Node 标准库 + bash |

### 1.2 活动量（GitHub 实测）

| 项 | 数字 |
|---|---|
| 工单 | **45 个，全部 closed（open 0）** |
| 按天建单 | 10-24: **17** · 10-25: **15** · 10-26: **5** · 10-27: **8** · **10-28: 0** |
| PR | **43 个**：merged **27** · closed 未合并 **16** · open **0** |
| PR 按天 | 19 / 14 / 5 / 5 / **0** |
| CI run | **累计 208 次**（api 只取最近 50 条，全 success；10-26:8、10-27:37、10-28:5） |
| 提交 | **159 个**，按天 21 / 45 / 48 / 26 / 19 |
| 标签分布 | `agent:done` 39 · `model:strong` 12 · `verdict:strict` 10 · `merge:auto` 10 · **`agent:failed` 6** · `agent:blocked` 2 |

未合并的 16 个 PR 里，**至少 6 个是刻意探针**（#19 删测试降基线、#20 改写断言重新 bless、#52/#53 冲突探针、#70 公开库 ruleset、#86 免费池故障转移），其余多为 10-24 早期的 helper 单被后续批次取代。**所以「63% 合并率」不是质量指标**——真正的失败指标是 6 个 `agent:failed`（45 单的 13%）。

### 1.3 成本（`.logs/usage.jsonl`）

- **39 行记录，累计 ¥1.2531**；只有 10-26（12 次）与 10-27（27 次），**10-28 一条都没有**。
- 单次区间 ¥0 – ¥0.316；模型分布 `DeepSeek-V4.1-Flash-1017` ×20、`strong` ×8、`deepseek-flash` ×7、`default` ×4。
- **每合并一个 PR 的分摊成本 ≈ ¥0.046**（¥1.2531 / 27）。这不是"AI 编程的价钱"，是"免费池的价钱"：付费档只在 3 个单上用过。

### 1.4 失败构成（`docs/failures.jsonl`，53 条）

| 根因 | 条数 | 占比 |
|---|---|---|
| 独立门禁未通过（调度器自己重跑 verify.sh 红了） | 12 | 23% |
| `[headless] agent-exit-1｜agent 未产生任何改动` | 11 | 21% |
| 语义评审拒绝 | 10 | 19% |
| 验收命令 exit≠0 | 6 | 11% |
| `worktree add 失败` | 4 | 8% |
| `llm-rate-limit` | 2 | 4% |
| `git fetch 失败`（路径里反斜杠被吃掉：`D:code.secretsssh-git.sh`） | 2 | 4% |
| CI `job: verify（失败步骤: Gate）` | 2 | 4% |
| `ReferenceError: path / GIT_ENV is not defined` | 2 | 4% |

**两个加起来 40% 的失败是「agent 空跑或没干成事」**（11 条空改动 + 10 条评审判它没做要求的事）。这部分的钱花得极少（空 run 几乎不计费），但**人的等待与重试轮次是主要损失**。

### 1.5 运行态（此刻）

- 常驻调度器 **pid 188268** 在跑（`dispatch.lock` = `{"pid":188268,"mode":"serve"}`，约 62 MB）；计划任务 `DSH Agent Dispatcher` 每 5 分钟 `--once` 敲门兜底。
- `.worktrees/` 空（没有在办的工单）；`.logs/dispatch.log` 每 ~60 秒写一行「没有待处理任务」。
- `events.jsonl` 里现在只有 1 条，还是别的会话写的 `ledger-prune` —— **流水线今天没有产生任何事件**。
- 免费池：**99 ok / 49 stale / 9 suspect / 1 unknown**（今天 14:35 时是 34 ok，探活 8 轮恢复到 99）。

---

## 2. 架构

### 2.1 分层（七层）

```
触发  登录自启(HKCU Run) / 计划任务每 5 分钟 --once / 手工 --ensure
调度  ci/dispatch.mjs：单实例锁 → 轮询 → 领取 → 并发池 → 收口
执行  ci/headless-task.sh：PATH / 模型路由 / 权限档 → DSH headless
      隔离：<盘>/.worktrees/issue-N（core.hooksPath=.githooks，.dsh/ 进 exclude）
门禁  scripts/verify.sh：lint → 单测 → 测试数基线 → 断言指纹 → build → pack
      + 提需求人写的「验收命令」（agent 改不动）
审查  ci/review.mjs（机械，看 diff 形状）+ ci/semantic-review.mjs（语义评审团）
记忆  docs/failures.jsonl（指纹，重试前回灌）→ ci/distill-failures.mjs → Hindsight
成本   ci/prices.mjs + usage.jsonl + 单任务/单日闸门（0.5 / 5 元）
恢复   ci/pool-block.mjs（判据）+ ci/blocked-recovery.mjs（退避重投）
```

### 2.2 一轮数据流

```
issue(agent:ready)
 → 打 agent:working、建 worktree、写 .dsh/PLAN.md
 → headless agent 干活（第 1 次弱模型，第 2 次起升 strong）
 → 自己跑门禁 → 红了带失败指纹重试（≤3 次）
 → 提需求人的验收命令 exit 0
 → 机械评审 → 语义评审团（免费档→付费面板）
 → 推 agent/issue-N、开 PR
 → checkAgentPRs：冲突自动 rebase、CI 红取日志回灌
 → CI 绿：有 merge:auto 自动 squash 关单，否则停在 PR 等人
```

### 2.3 十一条机制里，真正在承重的是这三条

| 承重机制 | 实现 | 为什么它重要 |
|---|---|---|
| **外部验收命令**（人写、agent 改不动） | `.dsh/PLAN.md` + 调度器重跑 | 堵住 AI 编程最典型的作弊：写一个断言自己结论的测试 |
| **门禁不信自述 + 指纹** | `scripts/verify.sh` 六步 + `assert-guard.mjs` | 删测试、改断言凑绿会在提交时直接红 |
| **两层评审** | `review.mjs`（形状）+ 语义评审团（意图） | 机械规则抓不住「能跑但没做要求的事」 |

其余八条（worktree 隔离、失败记忆、成本闸、锁与让位、标签补齐、事件通知、探活、多库多进程）是**让它能无人值守地连跑几天**的基础设施，不是正确性保障。

### 2.4 今天的改动（已推送）

`189c20a` + `f4dca86`：语义评审缺失改为**默认失败**（原来是 `ok:true / skipped` 静默放行）、PR body 打 `<!-- semantic:needs-human -->` 标记禁止自动合并、门禁放行写 `gate-override.jsonl` 留痕、usage 每次必写（无 token 记 `unmetered`）、通知加 webhook 出口、状态对账、池子健康快照。验证：277 单测全过、`verify.sh` OK。

---

## 3. 问题（按危害排序）

### P0-1 没有真实目标，只有「自举」

45 个工单全在这条流水线自己身上（helper 函数、ledger 子命令、探针）。**它优化的是自己，不是任何产品。** 结论：目前无法回答「这套东西做真实项目能省多少人力」——因为没有真实项目跑过。

### P0-2 人不在，它就停

四个环节必须有人：写工单与验收命令、打 `merge:auto`、发版、门禁放行。今天就是活例子：我（人）在，它反而 0 产出，因为**没有新单可领**。所以「无人值守」准确说是「无人干预地执行已有队列」，队列空了就静止。

### P0-3 权限面过大

调度器、agent、git 凭据、GitHub token 全在同一个 Windows 账号下，`D:\code\.secrets\` 对 agent 可读（`danger-full-access`）。`docs/architecture.md` 自己也把这条列为最大残余风险。门禁的「不许改裁判」目前靠 `DSH_ALLOW_GATE` 这个环境变量 + 留痕，**不是权限隔离**。

### P1-4 40% 的失败是「agent 空跑 / 没干成事」

11 条 `agent 未产生任何改动`、10 条语义评审拒绝。当前对策只有「重试 + 失败指纹回灌」，没有对「为什么它什么都没改」做归因（模型选错？PLAN 太糊？worktree 里缺上下文？）。

### P1-5 门禁未过（12 条）是最大单一失败源，且没有分类

这 12 条混着「真写错」「基线没 bless」「worktree 环境坏」三类，日志里只有一句 `独立门禁未通过`。修法不同（写错要重试、基线要 bless、环境要修），现在无法自动区分。

### P1-6 成本账有 23% 不计价（已修，未实跑）

改前 39 行里 9 行 `totalTokens=0`，且**usage 缺失时一行都不写** → 花掉的钱直接消失。今天已改成必写 + `unmetered` 分账，但**没有真实的空 run 再跑过一次**，属于「已改未验证」。

### P1-7 池子健康原先完全没有信号

今早实测池子从 102 ok 掉到 **34 ok** 而系统毫无反应（任务照跑、失败了才重试）。已加每小时快照写 `~/.dsh/coord/log/pool-snapshot.jsonl`，但**还没接进每日 digest**——写了没人看。

### P1-8 通知只到本机 Toast

`events.jsonl` + Windows Toast。人离开这台机器就收不到任何告警。webhook 出口今天做了（`DSH_NOTIFY_WEBHOOK`），**没有配真实远端**，等于没通。

### P2-9 结构问题

- `ci/dispatch.mjs` 2185 行，评审/成本/恢复/探活四支都长在里面；改一处要读一整天。
- 单机单点：机器关了就全停，没有第二台接管。
- 文档漂移：`progress-2026-10-25.md` / `report-2026-10-26.md` 是历史快照，数字（如「101 tests / 218 asserts」）与现在（277 / 572）差很多，容易误读。

---

## 4. 下一步（按投入产出排序）

| 优先级 | 做什么 | 验收标准 | 成本 |
|---|---|---|---|
| **1** | **换一个真实仓库跑 3 个真实工单**（不是 ledger） | 3 个 PR 合并进真实项目、含 1 次失败重试；人工介入 ≤1 次/单 | 半天（人写单 + 盯） |
| **2** | 把池子快照 + 失败分类接进每日 digest | 第二天早上能在 `events.jsonl`/digest 看到「池子 99 ok」与「昨日失败 12 条按类」 | 2 小时 |
| **3** | 配一个 webhook（飞书/钉钉） | 人为造一次 `agent:failed`，手机收到 | 1 小时 |
| **4** | 失败归因：把 12 条「门禁未过」拆成 写错/基线/环境 | `failures.jsonl` 新增 `cause` 字段并被 digest 统计 | 半天 |
| **5** | 拆 `dispatch.mjs` | 2185 行 → 4 个模块（领取 / 执行 / 收口 / 维护），单测数不降 | 1–2 天 |
| **6** | 低权隔离（换 Windows 用户或容器跑 agent） | agent 进程读不到 `.secrets` | 2–3 天，风险最高 |
| 7 | 需求来源自动化（从 TODO/issue 模板自动建单） | 队列空时能自己产出候选单，**但默认不自动开跑** | 1 天 |

**不建议现在做的**：自动合并（`merge:auto` 默认关着是对的）、自动发版、多机编排。在「真实项目跑通 3 单」之前，这些都只是给自举加复杂度。

---

## 5. 如果你要评估：看这六个数字

| 指标 | 现在 | 怎么读 |
|---|---|---|
| 产能 | 45 单 / 4 天 ≈ **11 单/天**（高峰日） | 但都是小单（helper 级），不代表真项目 |
| 合并率 | 27/43 = 63%（扣除探针后接近 100%） | 真正该看的是重试率：53 条失败指纹 / 45 单 ≈ **1.2 次失败/单** |
| 单位成本 | **¥0.046/合并 PR** | 钱不是瓶颈，人的时间才是 |
| 人的介入 | 每单 2 次（写单、合并） | 这是目前真正的「自动化率」上限：**约 50%** |
| 闲置率 | 10-28 全天 **100% 闲置** | 需求供给 = 人的时间，不是算力 |
| 质量守卫 | 277 单测 + 572 断言指纹 + 两层评审 | 这套比多数团队手写项目的门禁更严 |

**我的判断**：这条流水线的**工程完成度**已经高于「演示」水准（有锁、有退避、有失败记忆、有成本闸、有 277 个单测），但**产品价值未被证明**，因为它没做过任何一件真实工作。要不要继续投，取决于一个问题：**你手上有没有「需求多到人写不完」的排队？** 有，它是杠杆；没有，它是一台空转的精密机器。

---

## 6. 数据来源与复现命令

```bash
cd D:/code/dsh-pipeline-demo
git log --oneline | wc -l                       # 159
cat ci/*.mjs src/*.js scripts/*.sh scripts/*.js scripts/*.mjs | wc -l   # 7444
bash scripts/verify.sh                          # == verify: OK ==（277 单测）
wc -l < docs/failures.jsonl                     # 53
wc -l < .logs/usage.jsonl                       # 39
python -c "import json,io;rows=[json.loads(l) for l in io.open('.logs/usage.jsonl',encoding='utf-8')];print(sum(r.get('cny') or 0 for r in rows))"   # 1.2531
node ci/dispatch.mjs --pool-snapshot            # 池子健康快照
```

GitHub（token 在 `D:\code\.secrets\github-token.txt`，未回显）：

```
GET /repos/Satan1982/dsh-pipeline-demo/issues?state=all&per_page=100   # 45，open 0
GET /repos/Satan1982/dsh-pipeline-demo/pulls?state=all&per_page=100    # 43，merged 27
GET /repos/Satan1982/dsh-pipeline-demo/actions/runs?per_page=50        # 208 总，最近 50 全 success
```

**未验证 / 缺口**（如实标注）：

- webhook 只有出口，未配远端 → 生产上没通过。
- 成本报表新路径（`.logs/cost-report.md`）今天没跑过 → 明天的 07:00 才会第一次实跑。
- 今天新增的 4 类事件（`review-missing` / `review-degraded` / `state-drift` / `gate-override`）只有单测覆盖，**没有一次真实触发**。
- 人时成本没有任何计量（流水线不记录「人在这一步花了多久」），所以「省了多少人力」目前无法量化。
