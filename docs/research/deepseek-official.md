# DeepSeek 官方关于 AI 编程 / Coding Agent 的调研笔记

- 调研日期：**2026-10-26**（Asia/Shanghai）
- 抓取方式：`web_fetch`；GitHub 大页面改用 `raw.githubusercontent.com` / `api.github.com`（HTML 页面两次 30s 超时）；个别页面被本地 `dsh-defend` 规则 `generic-assignment` 误判为含机密而拦截 `web_fetch`，改用本地浏览器抓取工具取正文（已在「资料来源」中逐条标注）。
- 纪律：每条结论后附来源 URL；找不到的写「未找到」，不做推测性补全。标注「笔者推论」的段落**不是**官方说法。

---

## 0. 一页速览（结论先行）

| # | 结论 | 来源 |
|---|---|---|
| 1 | 现行 API 只有两个模型名：`deepseek-flash`（= DeepSeek-V4.1-Flash-1017）与 `deepseek-v4-pro`（= V4-Pro-0813）；上下文 **1M**、输出上限 **384K**、思考模式**默认开启**、effort 默认 `high` | api-docs 首页、pricing |
| 2 | 官方对编程场景的**强度建议**有三段演进：2026-04「复杂 Agent 场景用思考模式 + max」→ 2026-08「简单任务 low / 日常 Agent high / 高度复杂任务 max」；Claude Code 接入指引**直给** `CLAUDE_CODE_EFFORT_LEVEL=max` + `deepseek-flash[1m]` | news260424、news260813、claude_code 指引 |
| 3 | `/chat/completions` **无状态**，多轮改码的历史完全由客户端拼；思考模式下**带 tools 的请求必须完整回传 `reasoning_content`，否则 400** | multi_round_chat、thinking_mode |
| 4 | **代码补全（FIM）最大 4K**，且仅非思考模式；要项目级补全建议给「依赖文件的上下文」而非单文件 | fim_completion、DeepSeek-Coder README |
| 5 | Tool Calls：思考模式自 **V3.2 起**支持；**Chat Completion 不支持在对话中间插入 tool 消息**，长链 Agent 应改用 Anthropic API 或 Responses API | tool_calls |
| 6 | 「长文件会被截断」的**官方明确表述：未找到**。可证的硬限制是 384K 输出、FIM 4K 补全、以及 DSH 侧「单个超大单元无法靠压缩修复」 | 见 §5 |
| 7 | 「自动改多文件」的**操作性建议：未找到**。官方产品侧的默认是**人工审批**；官方示例自动化流水线（PR 评审）刻意用 **read-only** 且禁止改文件/分支/PR | github-review 示例、permission-presets |
| 8 | 官方宣传的多文件能力是「**从零构建完整项目**」（游戏、3D），卖点是「**较少提示词与素材、极短交互轮次**」，并声明针对 DeepSeek Harness / 腾讯 CodeBuddy / WorkBuddy 专门优化 | news261017 |

---

## 1. 研究范围与官方源清单（先给地图）

官方「编程能力」相关入口共三处，互相分工：

1. **API 文档站** `api-docs.deepseek.com`：模型名、定价、上下文/输出上限、思考模式、Tool Calls、FIM 补全、多轮对话、缓存、各家 Agent 工具接入指引。
2. **官网** `www.deepseek.com`：产品门面，`/harness/` 是自研 coding agent（DeepSeek Harness / DSH）的官方产品页；`/news/*` 是模型发布与研究文章。
3. **GitHub 组织** `github.com/deepseek-ai`：开源权重模型（DeepSeek-Coder / V3 / V3.2-Exp / R1 等）的 README 与用法建议、`deepseek-harness`（DSH 本体，MIT）、`awesome-deepseek-agent`（Agent 工具接入指南合集）。

关键事实：**DeepSeek-V4 / V4.1 系列没有 GitHub 仓库**，只发在 HuggingFace / ModelScope（`api.github.com/orgs/deepseek-ai/repos` 全量清单里没有 V4 系列；权重链接见 news260910 / news261017）。

抓取失败或受限、需在此声明的：`github.com/deepseek-ai` 与 `github.com/deepseek-ai/DeepSeek-Coder` 的 HTML 页面两次 30s 超时（改 raw 成功）；`huggingface.co` raw 抓取超时一次；`api-docs.../guides/thinking_mode` 与 `deepseek-harness.../guide/github-review` 的 `web_fetch` 被本地 defend 规则 `generic-assignment` 拦下（前者改用浏览器抓取工具、后者改用仓库 raw Markdown，内容一致）。

---

## 2. 硬参数：模型、上下文、输出、并发、缓存

### 2.1 模型名与别名（2026-10-26 状态）

| API 模型名 | 实际权重 | 备注 |
|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017（552B MoE，Causal-Encoder-Decoder，输入激活 8B / 输出激活 16B） | 旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调但已下线，按 Flash 计价 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 官方 2026-09-10 公告：计划有序下线 V4 Pro，2026-09-14 12:00 起请求路由到 V4.1 Flash 并按 Flash 单价计费 |

来源：`https://api-docs.deepseek.com/zh-cn/`（2026-10-26 抓取）；`https://api-docs.deepseek.com/zh-cn/news/news260910`（2026-10-26 抓取）。

> **存疑（不替官方圆场）**：定价页 `2026-10-26` 仍在列 `deepseek-v4-pro` 的独立单价，而 2026-09-10 公告说 V4 Pro 已路由到 V4.1 Flash。两处页面口径未对齐，实际计费以账单为准。

### 2.2 上下文与输出

- 上下文长度 **1M**，输出长度**最大 384K**；**1M 上下文是 DeepSeek 所有官方服务的标配**（不是某档 API 的加购项）。
  - 来源：`https://api-docs.deepseek.com/zh-cn/quick_start/pricing`；`https://api-docs.deepseek.com/zh-cn/news/news260424`（均 2026-10-26 抓取）。
- Claude Code 接入示例里的 `[1m]` 后缀（`deepseek-flash[1m]`）就是显式要 1M 上下文窗口：
  - 来源：`https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code`（2026-10-26 抓取）。

### 2.3 并发与其他限制

- 并发限制：**Flash 2500**、**V4-Pro 500**。
  - 来源：`https://api-docs.deepseek.com/zh-cn/quick_start/pricing`（2026-10-26 抓取）。
- FIM 补全（Beta）：**模型最大补全长度 4K**（硬限制），需 `base_url=https://api.deepseek.com/beta`，**仅非思考模式**支持。
  - 来源：`https://api-docs.deepseek.com/zh-cn/guides/fim_completion`；`https://api-docs.deepseek.com/zh-cn/quick_start/pricing`（2026-10-26 抓取）。
- 图像理解：Flash 支持，V4-Pro 不支持（同上 pricing 页）。
- 缓存：默认全量开启，返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；只匹配**输入前缀**，尽力而为、不保证 100% 命中；缓存构建秒级，几小时到几天不用会清空。
  - 来源：`https://api-docs.deepseek.com/zh-cn/guides/kv_cache`（2026-10-26 抓取）。
- KV Cache 压缩（成本相关）：V4.1 Flash 把 HBM 需求降到上代的 **1/4**、SSD 需求降到 **1/8**，相对初代模型 KV Cache 累计缩小 **437 倍**；官方明确说「Agent 使用场景中，缓存命中的费用往往占比较高」。
  - 来源：`https://api-docs.deepseek.com/zh-cn/news/news260910`（2026-10-26 抓取）。

### 2.4 定价（元 / 百万 tokens，含峰谷）

| 项 | Flash·空闲 | Flash·高峰 | V4-Pro·空闲 | V4-Pro·高峰 |
|---|---|---|---|---|
| 缓存命中输入 | 0.02 | 0.04 | 0.15 | 0.30 |
| 缓存未命中输入 | 1 | 2 | 4.5 | 9.0 |
| 输出 | 4 | 8 | 13.5 | 27.0 |

- 高峰时段：北京时间**周一至周五（不含法定节假日）9:00–12:00、14:00–18:00**；其余时间与周末/节假日全天为空闲，**空闲价为高峰的一半**。
- 扣费优先扣赠送余额。
- Search / Fetch 独立 API：**5 元 / 千次成功请求**；在 Harness / Claude Code / Codex 中经 Server 端工具调用**暂未计费**，**2026-11-01 00:00 起按次收费**。
  - 来源：`https://api-docs.deepseek.com/zh-cn/quick_start/pricing`（2026-10-26 抓取）。

> 编程场景的直接含义（笔者推论，非官方）：Agent 任务每个 step 都要重发全量历史，因此**输出价 / 未命中输入价**比缓存命中价重要得多；把「稳定前缀」（系统提示、仓库说明、工具 schema）放在前、把变动内容放后，命中率差异可到 50 倍量级（1 → 0.02）。

---

## 3. 官方推荐的编程用法

### 3.1 提示词实践

**（a）现行 V4.1 系列的官方档位建议（最重要的一条）**

- 2026-04-24（V4 预览版）：「**对于复杂的 Agent 场景建议使用思考模式，并设置强度为 max**」。
- 2026-08-13（V4-Pro 正式版）：思考强度按任务复杂度分三档——「**简单任务 low、日常 Agent 任务 high、高度复杂任务 max**」。
- 官方自己的 Code Agent 公开基准测试条件：「**使用 DeepSeek Harness 极简模式作为框架，max 档位，top_p=0.95，temperature=1.0**，其他框架结果可能略有不同」。
- 官方 Claude Code 接入指引直接写 `CLAUDE_CODE_EFFORT_LEVEL=max`，Sonnet/Opus 档位都映射到 `deepseek-flash[1m]`。
- 来源：`https://api-docs.deepseek.com/zh-cn/news/news260424`、`.../news/news260813`、`.../quick_start/agent_integrations/claude_code`（均 2026-10-26 抓取）。

**（b）思考模式的参数行为（照抄会踩的坑）**

- 开关：OpenAI 兼容格式 `{"thinking": {"type": "enabled"/"disabled"}}`（在 OpenAI SDK 里须塞进 `extra_body`）；Anthropic 格式同名字段；Responses API 用 `{"reasoning": {"effort": "none/low/high/max"}}`，`none` = 关闭思考。
- 强度：OpenAI `reasoning_effort` = `low/high/max`；Anthropic `output_config.effort` = `low/high/max`。
- effort 映射表：`minimal→low`、`low→low`、`medium→high`、`high→high`、`xhigh→high`、`max→max`、`ultra→max`（理解成「三档 + 别名」）。
- 思考模式**不支持** `temperature`、`presence_penalty`、`frequency_penalty`：设置**不报错但也不生效**。
- `top_p`：`deepseek-flash` 仅思考模式生效，有效范围 **0.95–1.0**，低于 0.95 按 0.95 处理，非思考模式恒为 1.0；`deepseek-v4-pro` 思考模式下忽略传入值（带 tools 固定 0.95，否则 1.0），非思考模式生效。
- 来源：`https://api-docs.deepseek.com/zh-cn/guides/thinking_mode`（2026-10-26 抓取）。

**（c）官方给的 system prompt 范本（历史模型，可作风格参考）**

DeepSeek-Coder 仓库给的 chat 模板是标准「编程助手」system 提示：

> You are an AI programming assistant, utilizing the DeepSeek Coder model, developed by DeepSeek Company, and you only answer questions related to computer science...

配合 `### Instruction:` / `### Response:` 分段与 `<|EOT|>` 结束符；instruct 模型做补全时要把 `eos_token_id` 由 32021 改成 32014。
来源：`https://github.com/deepseek-ai/DeepSeek-Coder`（README，raw 抓取，2026-10-26）。

**（d）R1 时代的五条硬建议（现役模型已换，但最后一条仍有普适性）**

1. temperature 取 **0.5–0.7**（推荐 0.6），防无尽重复 / 不连贯；
2. **避免加 system prompt，把所有指令放 user prompt**；
3. 数学题加「Please reason step by step, and put your final answer within \boxed{}」；
4. 评测多次取平均；
5. 模型有时会「绕过思考」直接输出 `\n\n`，**建议强制模型以 `\n` 开头输出**以确保充分推理。

来源：`https://github.com/deepseek-ai/DeepSeek-R1`（README，raw 抓取，2026-10-26）。

> 注意第 2 条只适用于 R1 那个世代（官方当时在 web/app 端确实不用 system prompt，只用 file-upload / web-search 两个模板）。现行 API 文档与 Claude Code 指引都正常使用系统提示，**不要拿 R1 的「禁用 system prompt」套到 V4.1 上**。

**（e）DSH 的官方起手提示词**

官方快速开始给的第一句任务是：「Summarize this repository and identify its main packages.」——即官方推荐的仓库切入点：**先摸清仓库结构与包边界，再动代码**。
来源：`https://deepseek-harness.github.io/deepseek-harness/guide/quickstart`（2026-10-26 抓取）。

### 3.2 上下文组织

- **API 无状态**：`/chat/completions` 服务端不记录任何上下文，每一轮请求必须由客户端把此前全部对话拼进 `messages`；官方示例就是每轮 `messages.append(response.choices[0].message)` 再追加新 user 消息。
  - 来源：`https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat`（2026-10-26 抓取）。
- **思考模式的多轮拼接规则**：
  - 请求**不带 tools**：历史轮 `reasoning_content` 无需回传，即使传了也会被忽略、**不拼进上下文**（省钱）；
  - 请求**带 tools**：**后续所有请求必须完整回传 `reasoning_content`，即使该轮没真正调用工具**，否则 API 返回 **400**；
  - 便捷写法 `messages.append(response.choices[0].message)` 等价于 append `{role:'assistant', content, reasoning_content, tool_calls}`。
  - 来源：`https://api-docs.deepseek.com/zh-cn/guides/thinking_mode`（2026-10-26 抓取）。
- **前缀缓存的组织方式**：命中条件是「输入前缀逐单元完全重复」。官方说明落盘时机为用户输入结束位置、模型输出结束位置、公共前缀检测点，以及长输入/长输出按固定 token 间隔落盘。
  - 来源：`https://api-docs.deepseek.com/zh-cn/guides/kv_cache`（2026-10-26 抓取）。
- **DSH 侧的上下文治理（官方产品文档）**：压缩（compaction）是可选能力 seam，触发原因只有两种——`pressure`（压力）与 `context-overflow`（上下文溢出）；压缩把选中的 surface 片段替换成**一个摘要节点**，并保持工具调用/结果配对不被切断；**「单个超大保留单元或请求封装无法通过 surface 压缩修复」**。
  - 来源：`https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.zh.md`（2026-10-26 抓取）。

### 3.3 多轮改码 / 补全

- **项目级补全的做法（官方给的示例，明确是「多文件上下文」范式）**：DeepSeek-Coder README 演示把 `utils.py`、`model.py` 的上下文一起给模型，让它补 `main.py`；并支持 fill-in-the-middle（`<｜fim▁begin｜>` / `<｜fim▁hole｜>` / `<｜fim▁end｜>`）做「中间插入」。
  - 它的数据构建就是为这件事服务的：按仓库内依赖重排文件顺序 → 把依赖文件拼接成单样本 → repo-level minhash 去重。
  - 来源：`https://github.com/deepseek-ai/DeepSeek-Coder`（README，2026-10-26）。
- **线上 FIM 补全**：Beta，4K 上限，官方推荐配 VSCode 插件 **Continue** 使用（集成文档在 `awesome-deepseek-integration/docs/continue/README_cn.md`）。
  - 来源：`https://api-docs.deepseek.com/zh-cn/guides/fim_completion`（2026-10-26 抓取）。
- **长对话改码的接口选择**：Chat Completion **不支持**在对话中间插入 tool 调用消息与 system 消息（只能中间插 system）；需要在历史中间插入 tool 调用，得换 **Anthropic API（`/messages`）或 Responses API**。
  - 来源：`https://api-docs.deepseek.com/zh-cn/guides/tool_calls`（2026-10-26 抓取）。

---

## 4. Agent / Tool use 官方建议

| 主题 | 官方口径 | 来源（2026-10-26 抓取） |
|---|---|---|
| 提示词 vs 工具 | 模型返回 function call，用户执行后以 `{"role":"tool","tool_call_id":...,"content":...}` 回传，循环到没有 tool_calls 为止 | guides/tool_calls |
| 思考模式 + 工具 | 思考模式**自 DeepSeek-V3.2 起**支持工具调用；可在输出最终答案前做多轮思考与工具调用 | guides/tool_calls、guides/thinking_mode |
| 强约束输出 | `strict` 模式（Beta，需 `/beta` base_url）：object 的所有属性必须 `required` 且 `additionalProperties: false`；支持 `object/string/number/integer/boolean/array/enum/anyOf/$ref/$def`；string 支持 `pattern`/`format`(email,hostname,ipv4,ipv6,uuid)，**不支持 minLength/maxLength**；array **不支持 minItems/maxItems** | guides/tool_calls |
| Agent 场景强度 | 「复杂 Agent 场景 → 思考模式 + max」（260424）；「简单 low / 日常 Agent high / 高度复杂 max」（260813）；官方基准用 Harness 极简模式 + max | news260424、news260813 |
| 针对主流 Agent 产品适配 | 对 Claude Code、OpenClaw、OpenCode、CodeBuddy、WorkBuddy、Codex（原生 Responses API + 一键配置脚本）做过专门适配；V4.1-Flash-1017 着重针对 **DeepSeek Harness、腾讯 CodeBuddy、WorkBuddy** 优化，要求 Harness ≥ 0.2.1-rc.1 | news260424、news260813、news261017 |
| 官方 Agent 接入目录 | `awesome-deepseek-agent` 收录 23 个工具的分步接入指南（Claude Code、Codex、Cline、Crush、OpenCode、OpenClaw、Pi、Qoder、Qwen Code、Reasonix、DeepSeek-TUI 等） | github.com/deepseek-ai/awesome-deepseek-agent |
| Harness 自身定位 | 「理解项目、修复问题、开发功能、运行测试」；Agent 可读写工作区文件、运行命令、委派工作、维护计划；**「如果根据当前权限策略，某项操作需要审批，Web UI 会先询问你」** | www.deepseek.com/harness/、guide/quickstart |

补充（Claude Code 官方接入环境变量的完整集合，2026-10-26 抓取自 `.../agent_integrations/claude_code`）：
`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`ANTHROPIC_AUTH_TOKEN=<你的 Key>`、`ANTHROPIC_MODEL=deepseek-flash[1m]`、`ANTHROPIC_DEFAULT_OPUS_MODEL`/`SONNET_MODEL`=`deepseek-flash[1m]`、`ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash`、`CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash`、`CLAUDE_CODE_EFFORT_LEVEL=max`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432`。
模型名映射：`claude-opus*` → `deepseek-v4-pro`（按 V4 Pro 计价），`claude-haiku*` / `claude-sonnet*` → `deepseek-flash`。
`awesome-deepseek-agent/docs/claude_code.md` 版本略旧（仍写 `deepseek-v4-pro[1m]` 并带 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`），以 API 文档页为准。

---

## 5. 能力边界与已知限制（含「未找到」项）

### 5.1 有原文依据的硬限制

| 限制 | 原文要点 | 影响 | 来源（2026-10-26 抓取） |
|---|---|---|---|
| 输出上限 | 输出长度最大 **384K** | 一次性吐超大文件/超长补丁仍有上界，超出需分段 | quick_start/pricing |
| 补全上限 | FIM **最大补全长度 4K**，且仅非思考模式 | 编辑器内联补全只能小步走；大改必须走 chat/tool | guides/fim_completion、pricing |
| 中间插 tool 不支持 | Chat Completion 只支持中间插 system，**不支持中间插 tool 调用消息** | 长链 Agent 若要在历史中回填工具结果，必须换 Anthropic / Responses API | guides/tool_calls |
| 思考模式下采样参数失效 | `temperature`/`presence_penalty`/`frequency_penalty` 设置不生效；`top_p` 范围受限或被忽略 | 「温度调低求稳定」在思考模式里无效，稳定性靠档位与提示词 | guides/thinking_mode |
| reasoning_content 回传义务 | 带 tools 的请求，后续**所有**请求必须完整回传 `reasoning_content`，否则 **400** | 自研 Agent 循环最容易踩的一条；截断/丢弃历史思考链会直接炸 | guides/thinking_mode |
| 无状态 | 服务端不记上下文，历史拼接完全由客户端负责 | 「多轮改码」的上下文组织 = 你自己的工程问题 | guides/multi_round_chat |
| 缓存不保证 | 前缀命中、尽力而为、久不用会清空 | 成本模型不能假设稳定命中 | guides/kv_cache |
| 单单元不可压缩 | DSH 压缩文档：「单个超大保留单元或请求封装无法通过 surface 压缩修复」 | 一次读入巨大文件后无法靠压缩救回，只能**分步读/切片读** | dsh docs/subsystems/compaction.zh.md |

### 5.2 R1 时代的模型侧已知问题（历史资料，用于理解官方口味）

- 无尽重复 / 输出不连贯 → 用 temperature 0.5–0.7；
- 会「跳过思考」直接输出 `\n\n` → 强制以 `\n` 开头；
- 官方在 web/app 端**不用 system prompt**，改走模板（文件模板：`[file name]: {file_name}\n[file content begin]\n{file_content}\n[file content end]\n{question}`；搜索模板：`[webpage X begin]...[webpage X end]` 包裹结果并要求 `[citation:X]` 引用）。
- 来源：`https://github.com/deepseek-ai/DeepSeek-R1`（2026-10-26 抓取）。

### 5.3 代码能力数字（官方自报，注意口径与年份）

| 模型 | 代码相关基准 | 来源 |
|---|---|---|
| DeepSeek-Coder-Base-33B | 比 CodeLlama-34B：HumanEval-Python +7.9%、Multilingual +9.3%、MBPP +10.8%、DS-1000 +5.9% | DeepSeek-Coder README |
| DeepSeek-Coder-Instruct-33B | HumanEval 超过 GPT-3.5-turbo；Base-7B 已达 CodeLlama-34B 水平 | 同上 |
| DeepSeek-R1 | LiveCodeBench Pass@1-COT 65.9；Codeforces percentile 96.3；**SWE Verified (Resolved) 49.2**（V3 为 42.0，Claude-3.5-Sonnet 50.8）；Aider-Polyglot 53.3 | DeepSeek-R1 README |
| DeepSeek-V3.2-Exp | 相对 V3.1-Terminus：LiveCodeBench 74.9→74.1、Codeforces 2046→2121、Aider-Polyglot 76.1→74.5、**SWE Verified 68.4→67.8**、Terminal-bench 36.7→37.7 | DeepSeek-V3.2-Exp README |
| V4 / V4.1 | **Agentic Coding 评测中达当前开源模型最佳水平**；官方自述内部使用体验「优于 Sonnet 4.5，交付质量接近 Opus 4.6 非思考模式，但仍与 Opus 4.6 思考模式存在一定差距」；V4.1 Flash 「性能、费用、速度、总用时全面超越 V4 Pro」 | news260424、news260910 |

V3.2-Exp 的已知实现坑（官方 Update 2025.11.17）：旧版推理 demo 在 indexer 模块的 RoPE 实现有偏差（indexer 需 non-interleaved、MLA 需 interleaved），可能导致性能下降，已修复——自己搭推理服务的人要注意。
来源：`https://github.com/deepseek-ai/DeepSeek-V3.2-Exp`（2026-10-26 抓取）。

### 5.4 明确「未找到」的项

- **「长文件会被截断」的官方明确表述：未找到。** 已检索 API 文档全站（首页、pricing、thinking_mode、tool_calls、fim_completion、multi_round_chat、kv_cache、claude_code 接入页）、2026 年全部 4 篇模型新闻、DeepSeek-Coder / R1 / V3.2-Exp 三个 README、DSH 指南与 reference 首页，没有任何一句说「长文件会被截断」。可替代的硬证据只有 §5.1 中 384K 输出上限、4K 补全上限、以及 DSH「单单元不可压缩」。
- **「官方要求必须分步执行（step-by-step 拆任务）」的明确表述：未找到。** 官方只有间接约束：FIM 4K、Chat Completion 不支持中间插 tool、compaction 无法修复超大单单元、R1「强制以 `\n` 开头以充分推理」。这些构成「小步走更稳」的技术依据，但**不是**官方写下的操作规范。
- **官方公众号 / 官方博客原文：未获取。** `www.deepseek.com` 页脚只给公众号二维码图片，没有可抓取的公众号文章集；站内「研究」栏目（`/news/deepseek-v4-1-flash/` 等）与 API 文档站新闻页内容同源，无额外编程实践文章。此类二手转载**未纳入**本笔记的事实来源。

---

## 6. 「自动改多文件」：官方立场（分三层，别混为一谈）

**（1）模型能力层：官方明确宣传「整项目生成」**

- V4.1-Flash-1017 的宣传点就是「**许愿式编程，一键成真**」，靠基于自反馈的 RL 提升「**从零构建完整项目**」的能力，案例包括故宫 3D、网页赛车游戏、godot 复刻《传送门2》、Valley of Ages；官方强调的卖点是**更少的提示词与素材、极短的交互轮次**。
- 来源：`https://api-docs.deepseek.com/zh-cn/news/news261017`（2026-10-26 抓取）。
- 结论：官方**不反对**让模型一次产出多文件项目，反而以此为卖点。

**（2）产品/安全层：官方默认是「人来批」**

- DSH 官方说明：「Agent 可以读取和编辑工作区文件、运行命令、委派工作并维护计划。**如果根据当前权限策略，某项操作需要审批，Web UI 会先询问你。**」
  - 来源：`https://deepseek-harness.github.io/deepseek-harness/guide/quickstart`（2026-10-26 抓取）。
- 官方权限预设表：默认自带 `workspace-write`（=`workspace-write` 沙箱 + `ask` 审批）与 `danger-full-access`（=`danger-full-access` + `never`）；`auto` 是保留名，固定为 `danger-full-access` + `ask`，由 Auto review 集成按会话发布。
  - 来源：`https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/permission-presets.zh.md`（2026-10-26 抓取）。
- 官方示例的自动化流水线（GitHub PR 就绪 → 自动起评审会话）刻意收紧权限：**选 `read-only` permission preset**，且规则**禁止修改文件、分支、PR 或 GitHub 状态**，把 webhook JSON 标记为不受信任的元数据。
  - 来源：`https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/github-review.zh.md`（2026-10-26 抓取）。

**（3）操作性建议层：「什么时候该让 Agent 全自动改多个文件」——未找到官方表述。**

- 已检索：`www.deepseek.com/harness/`、DSH 入门与参考文档、`awesome-deepseek-agent` 全部指南入口、API 文档的编程相关页、2026 年 4 篇模型新闻。**没有任何一页给出「多文件自动改写」的准入条件、批处理策略或风险清单**。
- 能确定的是官方**行为取向**：模型侧鼓励整项目生成（少提示、短轮次），产品侧默认保留人工审批、并对自动化流程用只读权限。二者并不矛盾——「生成」与「落盘」被审批闸门分开。

---

## 7. 对写代码 Agent 的落地要点（笔者推论，非官方）

1. `reasoning_content` 是硬约束：只要请求带 `tools`，历史轮思考链必须原样回传，**任何截断/摘要都会 400**。自研循环要在日志层保留完整，不要自己裁剪。
2. 稳定性别靠 `temperature`：思考模式下它不生效。要稳定就固定 effort 档位（日常 `high`、高难 `max`），并在提示词里压住输出格式。
3. 上下文要「结构化分步」而不是「一次读完」：384K 输出 / 4K 补全 / 单单元不可压缩三条限制叠加，意味着大改动应该拆成「读 → 定位 → 小补丁 → 验证」的步骤序列，而不是一次全量重写。
4. 缓存即成本：系统提示 + 工具 schema + 仓库说明放前面且别频繁改，变动内容（用户消息、diff、工具结果）放后面。错峰（空闲时段半价）+ 前缀复用是省钱的两个主要杠杆。
5. 自动化流水线按官方示例走：默认给**只读或 workspace-write + ask**，把「写」的权限单独授予，不要一上来 `never`。

---

## 8. 资料来源（全部于 **2026-10-26** 抓取）

### API 文档站（api-docs.deepseek.com）
1. 首次调用 API（模型名、base_url、Agent 工具接入入口）— https://api-docs.deepseek.com/zh-cn/
2. 模型 & 价格（上下文 1M、输出 384K、功能矩阵、价目、并发、Search/Fetch 计费）— https://api-docs.deepseek.com/zh-cn/quick_start/pricing
3. 接入 Claude Code（环境变量、模型映射）— https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code
4. Tool Calls（含 strict 模式 Beta）— https://api-docs.deepseek.com/zh-cn/guides/tool_calls
5. FIM 补全（Beta，4K 上限）— https://api-docs.deepseek.com/zh-cn/guides/fim_completion
6. 多轮对话（无状态 API）— https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat
7. 上下文硬盘缓存 — https://api-docs.deepseek.com/zh-cn/guides/kv_cache
8. 思考模式（开关、effort 映射、reasoning_content 回传）— https://api-docs.deepseek.com/zh-cn/guides/thinking_mode ※ `web_fetch` 被本地 defend 规则 `generic-assignment` 拦截，改用本地浏览器抓取工具取正文
9. 新闻：DeepSeek V4.1 Flash 10017 版本（2026-10-17，「许愿式编程」）— https://api-docs.deepseek.com/zh-cn/news/news261017
10. 新闻：DeepSeek V4.1 Flash 发布（2026-09-10，552B MoE、KV Cache 压缩、V4 Pro 下线计划）— https://api-docs.deepseek.com/zh-cn/news/news260910
11. 新闻：DeepSeek V4-Pro 正式版（2026-08-13，三档 effort、Code Agent 测试条件、Responses API / Codex）— https://api-docs.deepseek.com/zh-cn/news/news260813
12. 新闻：DeepSeek V4 预览版（2026-04-24，Agentic Coding 自评、复杂 Agent 用 max）— https://api-docs.deepseek.com/zh-cn/news/news260424

### 官网（www.deepseek.com）
13. 首页（产品/研究入口导航）— https://www.deepseek.com/
14. DeepSeek Harness 产品页（定位「写代码、改仓库」、npx 启动、MIT）— https://www.deepseek.com/harness/

### GitHub：模型仓库（README，raw 抓取）
15. DeepSeek-Coder（2T tokens 语料构建、16K 窗口、FIM、仓库级补全、chat 模板、微调脚本）— https://github.com/deepseek-ai/DeepSeek-Coder
16. DeepSeek-R1（Usage Recommendations 五条、模板、代码基准）— https://github.com/deepseek-ai/DeepSeek-R1
17. DeepSeek-V3.2-Exp（DSA 稀疏注意力、基准对比、RoPE 实现修正）— https://github.com/deepseek-ai/DeepSeek-V3.2-Exp
18. 组织仓库全量清单（用于确认 V4 系列不在 GitHub）— https://api.github.com/orgs/deepseek-ai/repos

### GitHub：DeepSeek Harness（DSH）
19. 使用 Web UI（快速开始、示例提示词、审批语义）— https://deepseek-harness.github.io/deepseek-harness/guide/quickstart
20. 架构总览（插件化、profile/bundle、能力 seam）— https://deepseek-harness.github.io/deepseek-harness/reference/
21. GitHub 评审会话（自动化 webhook + 只读权限 + 禁止改文件）— https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/github-review.zh.md ※ `web_fetch` 被同一 defend 规则拦截，改用仓库 raw Markdown
22. 权限预设（默认 `workspace-write`+`ask`、`danger-full-access`+`never`、`auto` 语义）— https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/permission-presets.zh.md
23. 压缩（compaction）子系统（pressure / context-overflow 触发、单单元不可修复）— https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/compaction.zh.md

### GitHub：Agent 接入指南合集
24. awesome-deepseek-agent README（23 个工具的接入目录）— https://github.com/deepseek-ai/awesome-deepseek-agent
25. awesome-deepseek-agent / Claude Code 指南（配置文件名与环境变量写法）— https://github.com/deepseek-ai/awesome-deepseek-agent/blob/main/docs/claude_code.md

### 未获取 / 不可用
- 官方微信公众号文章原文（站点只提供二维码，无文章列表）。
- HuggingFace 上的 V4 / V4.1 模型卡与 `DeepSeek_V4.pdf`、`DeepSeek_V41_Tech_Report.pdf`：`raw.githubusercontent.com` 之外，`huggingface.co` 抓取一次超时，**未取正文**，本笔记未引用其内容。
