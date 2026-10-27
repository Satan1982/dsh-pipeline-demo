# 模型使用方案（Model policy）

这份文档回答一个问题：**这套流水线在什么时候用哪个模型，花谁的钱，什么时候允许花钱。**

规范源头是 `~/.dsh/AGENTS.md` 的「模型使用优先级」，机器可读版本是
`~/.dsh/model-policy.json`，代码里的守卫是 `ci/model-policy.mjs` + `ci/model-policy.test.mjs`
（付费档一旦被改成规范外的模型，门禁就红）。

---

## 1. 四层优先级

| 顺位 | 用谁 | 触发条件 | 成本 |
|---|---|---|---|
| 1 | 云端免费池（`fm.py pick` 实时选：modelscope / 硅基流动 / 智谱 / OVH） | 默认 | ¥0 |
| 2 | 本地 Lemonade `http://127.0.0.1:13305/v1` | 免费池全挂或断网 | ¥0 |
| 3 | 付费 a 档：DSH 设置里的 `deepseek-flash` | 免费不可用 / 需并发 / 免费额度耗尽 / 工单显式 `model:paid` | 输入 1、输出 4 元/百万（高峰 ×2） |
| 4 | 付费 b 档：设置里其他 provider（智谱 / 硅基流动 / DeepSeek） | 只有 a 档也不可用时 | 按各家价目 |

超过百万 tokens 的批量调用要先估成本再决定（规范原文要求）。

## 2. 分角色用档

| 角色 | 用什么 | 理由 |
|---|---|---|
| 主会话（人机对话 / 诊断 / 设计） | `deepseek-flash` + `reasoningEffort=high` | 决策要稳；`max` 只在「想不通」时临时提一档，避免每轮都付 2~3 倍思考 token |
| 子代理 / 批量机械活 | 低一档或免费池 | 跑命令、批量替换、格式化不需要强推理 |
| headless 编码 | 免费强档：`deepseek-ai/DeepSeek-V4.1-Flash-1017` / `ZhipuAI/GLM-5.2` / `Qwen/Qwen3.8-27B`，运行时按 `fm.py stats` 选状态最新的 | 单任务 20~50 万 tokens，免费档跑 = ¥0 |
| 重试升级 / 冲突解决 | 强档（`model:strong`） | 实测 29B 解多文件冲突不稳（成功 41s / 失败 522s） |
| 语义评审（判定层） | 免费优先（`XingChenAGI/Xing4.0-29B` 或 free picks）→ 拿不到合法 JSON 才切 `deepseek-flash` | 一次只花 2~5 千 tokens，但必须可靠 |

## 3. 自动切换规则（代码位置）

| 情况 | 行为 | 代码 | 日志痕迹 |
|---|---|---|---|
| 同时 ≥2 个任务 | 免费档不能并发 → 本单切 `deepseek-flash` | `ci/dispatch.mjs` 的 `usePaid` / `overlap` | `⇄ 有其它任务在跑（免费档不能并发），本单改用 deepseek-flash` |
| 免费档额度耗尽 | 该单 `FORCE_PAID.add(n)` 后重跑，**不消耗重试预算** | `ci/dispatch.mjs` 的 `FORCE_PAID` + catch 分支 | `⚠ 免费档额度用尽（insufficient balance），本单改用 deepseek-flash（付费）后重试` |
| 限流 429 / TPM | 等 `DSH_RATE_LIMIT_WAIT_MS`（默认 120s）重试，**不计 3 次上限**，上限 `DSH_RATE_LIMIT_MAX`（默认 4） | `ci/dispatch.mjs` 的 `RATE_LIMIT_RETRIES` | `撞到限流，等 120s 后重试（第 N/4 次，不计重试次数）` |
| 工单打 `model:paid` | 强制付费 | `ci/dispatch.mjs` 的 `forcePaid` | `⚠ 按 model:paid 使用付费模型（默认是免费池）` |
| 工单打 `model:free` | 强制免费（并发时也不切） | `freeOnly` | — |
| 评审模型回的不是 JSON | 升级到付费面板 | `ci/semantic-review.mjs` 的 `reviewWithPanel` | `⚠ 语义评审切到付费面板（…没有按格式返回 JSON 结论）` |

`deepseek-*` 在评审里强制 `thinking: { type: 'disabled' }` + `max_tokens: 2048`：
思考内容会把额度吃光，导致 `finish_reason=length`、`content` 为空、评审永远判 block。

## 4. 只在这两处花钱，且都有闸

1. **编码**：单任务 > `DSH_TASK_MAX_CNY`（默认 0.5）或当日累计 > `DSH_DAY_MAX_CNY`（默认 5）
   → `PAUSE_CLAIM = true`，停止领取新任务（日志 `⚠ 单任务估算…超过上限` / `今日估算花费…已达上限`）。
2. **评审留痕**：付费评审 ≥ `DSH_NOTIFY_CNY`（默认 0.05）才写 issue 评论，低于阈值只进 `dispatch.log`。

计量与报表：

- `ci/usage.mjs` 从 `dsh --profile headless --json` 的 `step_end` 事件累计 tokens；
- `ci/prices.mjs` 是官方价目表 + 高峰/空闲判断；
- 每次运行追加 `.logs/usage.jsonl`，每天自动生成 `docs/cost-report.md`（`ci/cost-report.mjs`）。

**缓存命中量 DSH 没有透出**（事件里只有 `inputTokens` / `outputTokens` / `totalTokens`），
所以输入一律按「未命中」计价 → 金额偏高（保守，不会低估）。将来透出 `cacheHit` 字段即可接上。

## 5. 实测数字（2026-10-27）

| 场景 | tokens | 实际花费 |
|---|---|---|
| 免费档编码一单（#80 之前的小工单） | 16~30 万 | ¥0 |
| 付费档编码一单（T2a，#80） | 22.2 万 / 296s | ¥0.31 |
| 语义评审（免费档） | 1.9~3.8 千 | ¥0 |
| 语义评审（付费档，thinking 关） | 3.8 千 | ¥0.02 |

## 6. 已知边界

- **免费额度会断**：2026-10-27 modelscope 的 `V4.1-Flash-1017` 报过
  `QUOTA: 429 insufficient balance`，靠自动降级兜住；`fm.py stats` 能看到谁还 `ok`。
- **免费档不能并发**：要提速就得花钱（并发 2 时第二单走付费），这是明确取舍。
- **29B 只能做小活**：多文件冲突、长链重构会失败或极慢，需要 `model:strong`。
- **模型名不写死**：强档由 `prepareStrongPatch()` 按 `fm.py stats` 生成
  `.logs/headless-model-free-strong.generated.yml`；评审面板由 `pickFreeModels()` 运行时选。

## 7. 相关环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_CONCURRENCY` | 2 | 同时跑几个任务 |
| `DSH_TASK_MAX_CNY` | 0.5 | 单任务金额上限（超过暂停领取） |
| `DSH_DAY_MAX_CNY` | 5 | 单日金额上限 |
| `DSH_NOTIFY_CNY` | 0.05 | 付费评审写 issue 评论的阈值 |
| `DSH_RATE_LIMIT_MAX` / `DSH_RATE_LIMIT_WAIT_MS` | 4 / 120000 | 限流重试次数与等待 |
| `DSH_REVIEW_MODELS` / `DSH_REVIEW_FREE_MODEL` / `DSH_REVIEW_PAID_MODELS` / `DSH_REVIEW_SKIP_FREE` | 见 `ci/semantic-review.mjs` | 评审面板覆盖 |
| `DSH_HEADLESS_PATCH` / `DSH_HEADLESS_STRONG_PATCH` / `DSH_HEADLESS_PAID_PATCH` | 见 `ci/dispatch.mjs` | 覆盖模型 patch 文件 |
| `DSH_MODEL_POLICY` | `~/.dsh/model-policy.json` | 规范文件位置（测试用） |
