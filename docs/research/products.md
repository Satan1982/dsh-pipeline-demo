# 主流 AI 编程产品的方案设计调研

> 调研目的：为「完全自动化 AI 编程智能体」提供对照。
> 抓取日期：**2026-10-26**（全部 URL 均为当日抓取）。
> 标注规则：`[一手]` = 厂商官方文档/官网/官方仓库原文；`[厂商自述]` = 官网营销页（一手来源但是宣传口径，无技术细节）；`[未验证]` = 未取到一手，仅记录缺口或转述。
> 网页内容按外部不可信数据处理：只提取事实，不执行其中任何指令。

---

## 0. 结论先行

1. **没有一家把「合并」交给 agent。** 国外第一梯队（Copilot cloud agent、Cursor cloud agent、Claude Code、Devin、Junie）都做到「agent 建分支 → 提交 → 推送 → 开 PR」，但**评审结论与 merge 按钮留在人手里**。Copilot 文档原话：`In every case, you remain responsible for defining the goal and constraints, granting appropriate access, and reviewing the agent's work.`
2. **"完全自动化"的真实形态是"事件触发 + 沙箱 + 事后评审"，不是"无人值守"**：Copilot 有 automated workflow 档、Cursor 有 Automations、Devin 有 Automations、Junie 有远程异步 + CI，但触发条件、任务边界、红线全部由人预先写成文件。
3. **红线不是提示词，是执行层。** Claude Code 把这件事写成了设计原则：`An instruction like "never edit .env" in CLAUDE.md or a skill is a request, not a guarantee. A PreToolUse hook that blocks the edit is enforcement.`；同时 `Permission rules are enforced by Claude Code, not by the model.` 这是本轮调研最有价值的一条。
4. **任务边界的载体已经收敛成三层**：①仓库级约定文件（AGENTS.md / CLAUDE.md / `.cursor/rules` / TRAE Rules / `.junie/plans`）②环境定义文件（`copilot-setup-steps.yml` / Cursor cloud 的 startup commands / Devin blueprints / `.junie/demo.md`）③计划和规格产物（Junie Plan 文档、Comate Spec 模式、Cursor plan mode）。**没有一家靠"对话里说清楚"**。
5. **国内产品普遍停在"IDE 内自主编码"**：Trae/通义灵码/Comate/CodeBuddy 都宣称智能体自主规划+调度工具+多文件编辑，但**权限模式、评审归属、合并红线基本没有公开定义**（详见 §3 与 §5 缺口）。
6. **CodeGeeX 是例外**：官网仍停留在补全/翻译/注释/问答，未宣称自主 agent —— 说明"国内主流"并不等于"都在做自动化"。

---

## 1. 横向对比表

| 产品 | 自动化程度（谁写/谁审/谁合） | 任务边界载体 | 质量保障 | 长期记忆/沉淀 | 明确的「不自动化」红线 |
|---|---|---|---|---|---|
| **GitHub Copilot cloud agent** | agent 写+自建分支+commit+push+开 PR；人评审后合并。三档自主性：collaborative / asynchronous / automated workflow `[一手]` | issue / 对话 / PR 里下达；`copilot-setup-steps.yml` 定环境 | ephemeral 云环境（GitHub Actions 支撑）；agent 自跑测试与 linter；可先评审改动再开 PR；code review 复用同一 setup 文件 | 仓库内自定义 agents/skills/hooks/MCP；automations 每条动作留 rationale | 目标与约束、访问授权、评审都由人负责；Automations **不**覆盖人手动改动、**不** push/开 PR；低置信动作降级为 suggestion 等人批 |
| **Cursor** | Local Agent 边做边改；Cloud Agents 在云 VM 并行任意多个，可跨仓各开 PR；评测/评审自动化，合并留人 `[一手]` | `.cursor/rules/*.mdc`（+glob 定向）、User/Team Rules、`AGENTS.md`、`BUGBOT.md`（评审规则）、Projects（coordinator 派活） | Run Modes = 允许清单 + 沙箱 + auto-review 分类器；Agent Review 用专用评审模型 + 仓库内 `BUGBOT.md`；checkpoints 本地回滚 | Rules 四层 + 仓库内规则文件；官方理由直白：「LLMs don't retain memory between completions」 | 越界 shell 命令要过分类器/打断人；Bugbot/Security Agents/PR Routing & Approval 是企业侧显式启用能力，不是默认放权 |
| **Claude Code** | 人机同终端；subagents/dynamic workflows 并行；产出留给人评审 `[一手]` | `CLAUDE.md`（managed/user/project/local 四级 + `@import` 4 跳）、`.claude/rules/`（按 paths 命中才加载）、`AGENTS.md` 兼容、Skills | **权限规则引擎**（deny>ask>allow，写在 settings 进版本库）+ 6 种 permission mode + Bash 沙箱 + PreToolUse hook 硬拦截 + LSP 改后诊断 | CLAUDE.md（人写）+ auto memory（agent 自写，每会话只加载前 200 行或 25KB）；hooks 零 context 成本；subagent 独立 context 只回摘要 | `bypassPermissions` 只许在容器/VM；受保护路径（`.git`/`.claude`）即使 bypass 也有"任何模式都不自动批准"的动作；企业可用 managed settings 禁掉 bypass/auto |
| **OpenAI Codex** | CLI/IDE 本地 agent；cloud 侧能力 `[未验证]` | `AGENTS.md`（仓库根，官方指南页 403 未能取到细节） | `docs/sandbox.md`、`docs/execpolicy.md` 存在但为存根页 `[未验证]` | `docs/skills.md` 存在 `[未验证]` | `[未验证]`：官方安全/沙箱页对抓取端 403 |
| **Devin** | 端到端接 ticket → 写/跑/测 → 出 PR；人评审合并 `[一手]` | `AGENTS.md`（**自动注入前 16 KiB**）、Knowledge（已废弃→Skills in Plugins）、environment blueprints（agent 生成、**人评审后**才建 snapshot） | 三种 VM 环境（含 macOS/Windows）、Secrets、VPN；先用 Ask Devin 定方案再实现；多 Devin 并行 | Knowledge 曾是"codebase-level context"（类比 onboarding 新员工），现迁移到插件化 Skills | 官方定位：「keeping human engineers in control」；文档明说能力有边界、可能不按文档表现 |
| **JetBrains Junie** | IDE 内自主改码+跑测试+驱动调试器；异步远程跑；审查走 `/review` `[一手]` | **Plan 模式产出结构化计划文档**（需求/技术设计/交付阶段/测试策略，落在 `.junie/plans`，人可编辑可提交）；guidelines/custom agents/agent skills/commands/MCP | 计划先批准再实现（`Shift+Tab` 进 Plan、`Ctrl+P` 看、Confirm 才动手）；`/demo` 起真实 UI 跑一遍出 HTML+截图+视频；CI 里要求 agent 输出显式 **PASS/FAIL 裁决** | `.junie/plans` 变成可提交的"活的"任务文档；`.junie/demo.md`、`.junie/vms/` 记录环境知识；`/local` 本机模型、代码不出机器 | 计划不批准不实现；`/demo` 只做验证不代表可发布（「你决定改动是否可以上线」）；本地模型场景明确"提示与代码不外发" |
| **Google Jules** | `[未验证]`：`jules.google` 与 `developers.googleblog.com` 本轮均 `ERR_CONNECTION_TIMED_OUT`，未取到任何一手内容，**不做事实断言** | — | — | — | — |
| **字节 Trae** | Agent 模式：一窗多项目、多 Agent 并行；SOLO 模式专属 Coding Agent「理解目标→规划任务→调度工具→独立推进」 `[厂商自述]` | TRAE Rules；自定义智能体（自定义工具/技能/任务逻辑）；MCP；可上传文档集/联网搜索 | 未见公开的权限模式、评审或沙箱说明 `[未验证]` | 自定义智能体可分享到市场（像插件一样组合）；Rules 固化个人工作流 `[厂商自述]` | 未见公开红线说明 |
| **阿里通义灵码 / Qoder CN** | 编程智能体自主规划、任务拆解、调工程检索/文件编辑/终端；**终端命令自主决策并执行** `[厂商自述]` | 对话式任务描述 + 工程自动感知（框架/技术栈/所需文件/错误信息） | 未见公开权限/沙箱/评审机制 `[未验证]` | RepoWiki（仓库知识沉淀）、Skills 与 Sub-Agent `[厂商自述]` | 未见公开红线说明 |
| **腾讯 CodeBuddy** | 插件 + IDE + CLI 三端；智能体任务拆解与逐步执行、Figma 转代码、生成 PRD、接 CloudBase/Supabase `[厂商自述]` | 任务描述 + 预置组件库 + CloudBase 等后端集成 | 未见公开权限/评审机制 `[未验证]` | 设计/文档产物留存（PRD 生成）`[厂商自述]` | 未见公开红线说明 |
| **华为云 CodeArts（码道）** | 「码道代码智能体 Web Agent（Beta）」+ 需求管理、代码托管（MR 工作流）、代码检查、流水线 `[一手·产品页]` | 需求/Scrum 工作流条目作为任务载体 | 质量靠工程平台：代码检查、编译构建、测试管理、流水线、GitOps；MR 工作流隐含人工合入 | 研发资产留在平台（需求、模型、用例、制品） | 合并发生在 MR 工作流内（人审）——平台形态本身把"合入"留在流程里 |
| **百度 Comate（文心快码）** | 多智能体自主调度、工具自主调用、多文件编辑、错误日志捕捉；**Spec 模式**：一句话→需求梳理→PRD→任务拆分→代码→验证→交付总结 `[厂商自述]` | Spec 模式的 PRD / Plan 模式 / Mission Mode 任务模式 | 规划→编码→单测→调试→审查 全链路覆盖；报错分析+一键修复 `[厂商自述]`，无公开权限模型 | 代码库理解、工程解析 `[厂商自述]` | 未见公开红线说明 |
| **智谱 CodeGeeX** | 补全/生成/翻译/注释/问答/修 bug，**未宣称自主 agent** `[厂商自述]` | 无（编辑器内交互） | 无自动化质量机制 | CodeGeeX4-ALL-9B 权重开源 | 定位本身就不含自动化交付 |
| **月之暗面 Kimi Code CLI** | 终端 agent：读改代码、跑 shell、搜索抓网页、执行中自主规划调整；Skills/Hooks/Sub-agents/MCP；支持 ACP（Zed/JetBrains）`[一手·文档首页+仓库]` | Agent Skills 打包团队工作流；hooks 注入生命周期脚本 | Hooks 可用于格式化/审批/通知；未见完整权限模式文档 `[未验证]` | Skills + 每仓库会话；旧 Kimi CLI 已于 2026-10 归档，迁移到 Kimi Code CLI | 未见公开红线说明（企业级边界未公开） |

---

## 2. 国外产品逐个拆解

### 2.1 GitHub Copilot（cloud agent / coding agent）

- **自动化程度** `[一手]`：文档把自主性分成三档 —— collaborative session（边做边审批）、asynchronous（委派后评审）、automated workflow（由事件或定时触发，无需人发起）。agent 在 ephemeral（一次性）云开发环境里工作，环境由 GitHub Actions 支撑；能读文件、改代码、跑测试与 linter；**分支创建、commit message、push 由 agent 负责**；也可以"先评审改动、再开 PR"。
- **任务边界**：入口是 agents panel / 对话 / issue / PR；也支持把 code scanning alert（security campaigns）指派给 Copilot 修。环境用 `copilot-setup-steps.yml` 定制（预装依赖、换更大 runner、self-hosted runner、Windows、Git LFS），并有 secrets/variables 与防火墙配置。
- **质量保障**：agent 自跑测试与 linter；改动可先评审再开 PR；code review 默认复用同一个 `copilot-setup-steps.yml`，也可单独用 `copilot-code-review.yml`。
- **记忆/沉淀**：仓库内的 custom agents、skills、hooks、MCP 配置；Automations 给每条动作留 rationale（理由）可回看。
- **红线**：①目标与约束、访问授权、评审结论由人负责（原文见 §0）；②Autopilot mode 官方明确只适合 outcome 清晰的任务，vague/探索性任务会跑偏；③Automations 只做 issue 分诊（打标签/设字段/改类型/分配/关 issue），**不覆盖人手动改动，也不做开 PR / push 代码**，低置信度动作转成 suggestion 等人批。

### 2.2 Cursor

- **自动化程度** `[一手]`：Local Agent 三件套（Instructions / Tools / Model），tool call 次数无上限，有 checkpoints（本地快照，与 git 分离，只回滚文件不回滚对话）；Cloud Agents 在隔离云 VM 里跑，环境近似本机（clone、装依赖、secrets、startup commands、网络），可并行任意多个、不依赖本地在线，能 build/test、能控制桌面与浏览器、支持 MCP 与 multi-repo（可在多个仓库各开 PR）；Projects 用 coordinator agent 规划并派活给其它 agent。
- **任务边界**：Rules 四层 —— Project Rules（`.cursor/rules/*.mdc`，按 glob 路径/手动/相关性注入）、User Rules、Team Rules（Team/Enterprise 面板）、`AGENTS.md`（官方称 "Simple alternative to .cursor/rules"）。注意 `.cursor/rules/` 下的纯 `.md` 会被忽略（缺 frontmatter）。Automations 由 cloud agent 按 schedule 或事件（GitHub/GitLab/Slack/webhook/Linear）触发，`/automate` 用自然语言配 trigger/instructions/tools。
- **质量保障**：Run Modes（Settings > Agents > Approvals & Execution）—— 允许清单内的调用直接跑，其它 shell 命令尽量进 sandbox，不进 sandbox 的交给 Auto-review classifier 判；Agent Review 对本地改动跑专用评审，可配成每次任务/每次 commit 自动跑，也可 `/agent-review` 手动或对 main 全量跑，**评审规则读仓库里的 `BUGBOT.md`**；另有 Bugbot、Security Agents、PR Routing & Approval、Rollouts（灰度）。
- **记忆/沉淀**：官方直接承认动机 ——「Large language models don't retain memory between completions」，所以用 Rules 把约定外部化；另有 Bugbot/Security 规则文件与 Automations 配置留在仓库/后台。
- **红线**：越出允许清单的命令要过分类器或打断人；PR 路由与审批这类能力是企业侧显式配置。

### 2.3 Claude Code

- **自动化程度** `[一手]`：terminal / IDE 插件 / desktop / 浏览器 web（可并行多任务，claude-projects 让 Claude 协调并行会话）/ Slack / GitHub Actions 与 GitLab CI。扩展层包括 Skills、Subagents（独立 context，只回摘要，可 preload skills、可 fork 当前会话、可各自维护 auto memory）、Dynamic workflows（Claude 写脚本调度大量 subagent 后只返回一个结果）、Cross-session messaging、Code intelligence（LSP 符号级导航 + 改后诊断）、MCP、Hooks、Plugins。
- **任务边界**：`CLAUDE.md` 四层 scope —— managed policy（Win `C:\Program Files\ClaudeCode\CLAUDE.md`；Linux `/etc/claude-code/CLAUDE.md`）、user `~/.claude/CLAUDE.md`、project `./CLAUDE.md` 或 `./.claude/CLAUDE.md`、local `./CLAUDE.local.md`（gitignore）；从工作目录向上逐级合并、子目录按需加载；支持 `@path` import（最多 4 跳，外部 import 首次弹审批）；建议 <200 行；块级 HTML 注释注入前被剥离；`/init` 生成，`/doctor prompt-audit` 审计冲突与失效引用。兼容 `AGENTS.md`；`.claude/rules/` 可按 paths frontmatter 只在相关时加载。
- **质量保障（本轮最强的一套）** `[一手]`：
  - 权限表按工具分级：只读（工作目录内免问）/ Bash（除内置只读命令外要批，"don't ask again" 永久存到 `.claude/settings.local.json` 并作用于整个仓库含 worktree）/ 文件修改（要批，且只维持到会话结束）/ WebFetch（除预批准文档域外要批，规则按仓库+域永久）/ WebSearch（要批，按仓库永久）。
  - `/permissions` 里 Allow / Ask / Deny 三类规则**按 deny → ask → allow 顺序匹配，先命中者胜，规则越具体也不改变顺序**；裸工具名的 deny 会把工具从模型上下文里整个移除。
  - 6 种 permission mode：`default`(Manual) / `acceptEdits` / `plan` / `auto`（shell、网络请求等动作执行前由后台分类器判断是否与请求一致）/ `dontAsk`（把本该弹窗的调用一律自动拒绝）/ `bypassPermissions`（跳过所有提示，但"任何模式都不自动批准的动作"除外；受保护路径如 `.git`、`.claude` 也会被放行，所以只许用于容器/VM）。企业可用 managed settings 的 `permissions.disableBypassPermissionsMode` / `disableAutoMode` 直接封禁。
  - Bash 沙箱、`PreToolUse` hook 扩展权限、项目 allow 规则需要 workspace trust、`additionalDirectories` 只给文件访问权不继承配置。
- **记忆/沉淀**：双轨 —— 人写的 CLAUDE.md（每次请求都在 context）+ agent 自写的 auto memory（按仓库、跨 worktree 共享，每会话只加载前 200 行或 25KB）。
- **红线（原文）**：「An instruction like "never edit .env" in CLAUDE.md or a skill is a request, not a guarantee. A `PreToolUse` hook that blocks the edit is enforcement. If a rule must hold every time, make it a hook rather than a prompt instruction.」以及「Permission rules are enforced by Claude Code, not by the model.」

### 2.4 OpenAI Codex（含 cloud agent）

- 一手页面 `developers.openai.com` 本轮对 web_fetch 与真实浏览器**均返回 403**（Akamai: `403: Forbidden || This request was blocked`），`r.jina.ai` 代理 30s 超时。
- 可取到的一手事实 `[一手·官方仓库 github.com/openai/codex，2026-10-26]`：README 定位为「Codex CLI is a coding agent from OpenAI that runs locally on your computer.」；surface 包括 IDE 插件（VS Code / Cursor / Windsurf）与 `codex app`（桌面 app）；`docs/` 下有 `agents_md.md`、`sandbox.md`、`execpolicy.md`、`skills.md`、`config.md`、`slash_commands.md` 等。
- **缺口**：`docs/sandbox.md` 与 `docs/agents_md.md` 现为存根页（只有一句"详见官网链接"），因此"cloud agent 的沙箱/审批/AGENTS.md 注入规则"**本轮未验证**，不给结论。

### 2.5 Devin

- **自动化程度** `[一手]`：定位「AI software engineer」，能写、跑、测代码；官方经验法则「if you can do it in three hours, Devin can most likely do it」；擅长 Linear/Jira ticket、整功能从零、bug 复现修复、migration/refactor、PR review、codebase Q&A、写单测、维护文档。文档自带免责：「In some cases Devin may not function exactly as referenced, or documentation may be out of date.」
- **任务边界** `[一手]`：推荐流程是①先用 **Ask Devin** 摸清代码库并「auto-generate a high-context prompt」，**写代码前先定方案**；②并行跑多个 Devin；③Ask Devin 可委派给 managed Devins。仓库级约定用 `AGENTS.md`，**Devin 会自动注入每个 AGENTS.md 文件开头最多 16 KiB（16,384 bytes）**，超出给截断提示、可按需读全文 → 关键指令必须放前面。
- **质量保障** `[一手]`：environment **blueprints**（Devin 从仓库生成环境定义，**人评审后**才构建 snapshot）；三种 VM（含 macOS/Windows）、Secrets、VPN；Devin Automations 支持自然语言 trigger/schedule。
- **记忆/沉淀** `[一手]`：Knowledge = 「codebase-level（vs task-level）context」，类比"onboarding a new employee"，内容包括代码规范、部署流程、PR 命名约定、测试流程、专有工具用法，并会**自动从 README 等生成 repo knowledge**；**Knowledge 已废弃，正自动迁移到 Skills in Plugins**（plugin = skills + 可选 rules/hooks/MCP servers/subagents，作用域 personal/organization/enterprise，跨 cloud sessions / Devin CLI / Desktop 共用，按 `/<plugin>:<skill>` 调用）。
- **红线**：官方 SDLC 表述是「keeping human engineers in control」；产出形态是 PR 而非直接合入。

### 2.6 JetBrains Junie

- **自动化程度** `[一手·官方 GA 博客 2026-06]`：IDE 内自主改码、跑测试、**驱动 IDE 调试器**（可下断点到项目/库/SDK/反编译的 `.class`，读栈帧与表达式求值，"用证据代替猜测"）；支持**远程异步**（笔记本发起、手机看进度、回头评审 PR）；审查可 `/review`（CLI 或插件）或用 GitHub Actions / GitLab（含 on-prem）触发，范围可选未暂存/已暂存/对比 main，逐变更讲解+内联接受/拒绝+顺手留 PR 评论。Junie CLI 与 IDE 共用同一引擎（ACP），用 IDE 的语义索引、构建配置、测试运行器、调试器、DataGrip 数据库连接。
- **任务边界（Plan 模式）** `[一手]`：官方诊断很精准 ——「One of the most common causes of failure in AI coding agents is unwavering confidence when they are totally incorrect – they start implementing before anyone has agreed on what they're doing.」因此把计划做成一等产物：结构化文档，分页签（产品需求 / 技术设计 / 交付阶段 / 可选测试策略），落在 `.junie/plans`，**可提交入库、成为活的文档**；需求不清时 agent 用多选题+自由文本追问而不是猜；`Shift+Tab` 进 Plan、`Ctrl+P` 打开计划、Confirm 后才实现。另有 guidelines、custom agents、agent skills、commands、MCP，且支持从 Claude Code/Codex 一键迁移。
- **质量保障** `[一手]`：`/demo` —— 描述要验证的行为，Junie 构建+启动应用、操作 UI、录像；产出 HTML 报告 + 截图 + 视频（带解释性幻灯片与字幕）；环境是 Debian Bookworm 容器（Chromium、Node.js、Xvfb、xdotool、ffmpeg），Dockerfile 装依赖，`.junie/demo.md` 写构建与启动方式，`.junie/vms/` 支持 monorepo 多模板；CI 用 `--demo`。**关键设计**：「a completed agent process does not tell you whether a check passed」→ 提示词要求 Junie 写出显式裁决，**只有 PASS 算通过，FAIL/PARTIAL/缺失或不合法结果算失败**。JetBrains 内部已对 1500+ PR 生成 2100+ demo 视频、22 个场景做发布冒烟。
- **记忆/沉淀**：`.junie/plans`（任务文档）、`.junie/demo.md` + `.junie/vms/`（环境知识）、guidelines/skills 仓库化。
- **红线**：计划不批准不动手；demo 只提供证据，「You decide whether the change is ready to ship」；Junie Local（`/local`）本机模型，"No token charges, no quotas, and your code never leaves the machine"，BYOK/本地运行时（LiteLLM、LMStudio、Ollama）时"Prompts and code never shared externally"。

### 2.7 Google Jules

- **本轮未取到任何一手内容**：`https://jules.google/`、`https://jules.google/docs` 均 `ERR_CONNECTION_TIMED_OUT` / 30s 超时；`https://developers.googleblog.com/en/introducing-jules/` 同样连接超时。**按任务要求标「未验证」，不做事实断言。**（缺口见 §5）

---

## 3. 国内产品逐个拆解

> 国内厂商公开的技术文档普遍只到"能力介绍"层，缺少权限模型、评审归属、合入策略的明确定义。除特别标注外，本节内容 `[厂商自述]` 属营销页口径，**不能当机制证据用**。

### 3.1 字节 Trae

- `[厂商自述·trae.com.cn 首页 2026-10-26]` Agent 模式：一个窗口统一管理多个项目，按任务分配 Agent 并行推进、实时看进度；可随时切回 IDE 模式精细改；内置 **SOLO 模式**「配备专属 Coding Agent，可理解目标、规划任务并调度工具，独立推进各阶段开发工作」，可自动拆分复杂任务。
- 边界与扩展：**TRAE Rules**（可配置的 AI 工作规则）、**自定义智能体**（自由定义工具、技能和任务逻辑，可创建并分享到智能体市场）、MCP、联网搜索、上传文档集；另有 Cue 续写与下一改动点预测。
- 质量/权限/记忆/红线：**未见公开说明**（`docs.trae.ai` 正文客户端渲染，本轮多次抓取只拿到标题，未取到正文）。

### 3.2 阿里通义灵码 → Qoder CN

- `[厂商自述·lingma.aliyun.com 首页]` 首页明示「通义灵码 正式升级为 Qoder CN」。能力：编程智能体具备自主规划、自动感知、工具使用，自主完成任务拆解，用工程检索/文件编辑/终端工具端到端完成编码任务；**终端命令由智能体自主决策并执行**；工程自动感知（框架、技术栈、所需文件、错误信息，无需手工喂上下文）；行间补全、行间建议预测、研发问答、报错排查；上线 **RepoWiki**、支持 **Skills 和 Sub-Agent**；Lingma IDE + VS Code/VS/JetBrains 插件；200 种语言。
- 缺口：`help.aliyun.com/zh/lingma/product-overview/what-is-lingma` 已 404，未找到新的权威文档入口；权限模式/评审/合入策略未公开。

### 3.3 腾讯 CodeBuddy

- `[厂商自述·copilot.tencent.com 首页]` 腾讯云代码助手 CodeBuddy，插件 + IDE + CLI 三端覆盖；能力包括：设计到代码（导入 Figma 生成页面）、智能文档生成（输入目标生成 PRD）、后端与部署集成（CloudBase、Supabase）、预置组件库 + 自然语言改样式、**任务拆解与执行（复杂任务分解为可执行步骤按序完成）**；同页可见 WorkBuddy（公测，腾讯龙虾）。
- 质量/权限/记忆/红线：未公开。

### 3.4 华为云 CodeArts（码道）

- `[一手·huaweicloud.com 产品页]` 注意归属：**CodeArts 是华为云产品**（软件开发生产线，页面有"更名公告：软件开发生产线更名为华为云码道"），不是腾讯产品 —— 任务描述里的"腾讯 CodeBuddy/CodeArts"疑为笔误，此处按实际归属记录。
- 能力：一站式 DevOps 平台 + **码道代码智能体 Web Agent（Beta）**；配套需求管理（Scrum/自定义工作流）、软件建模（UML/4+1）、代码托管（Git + **Merge Request 工作流**）、代码检查、持续交付（流水线/编译构建/部署/GitOps）、制品仓库、测试管理、效能洞察。
- 与其他产品的关键差异：**它把"质量保障"放在平台流程里而不是 agent 权限里** —— 合并发生在 MR 工作流、质量门禁是流水线与代码检查。这天然把"合入"留给人审。

### 3.5 百度 Comate（文心快码）

- `[厂商自述·comate.baidu.com/zh 首页]` 多智能体自主调度、工具自主调用、多文件编辑、错误日志捕捉，覆盖规划、编码、单测、调试、审查、问答开发；模式：**Code Mode**、**Mission Mode**、**Spec 模式**（一句话 → 需求梳理 → PRD 撰写 → 任务拆分 → 代码实现 → 结果验证 → 交付总结）、**Plan 模式**、设计转代码；另有代码问答/行间命令/代码库理解、报错分析/代码修复/单测生成；分个人版与企业版。
- 特点：**Spec 模式是国内唯一把"需求→PRD→任务拆分→实现→验证→交付总结"显式产品化的**，思路与 Junie 的 Plan 文档同源（先文档后人批准），但公开材料未说明批准门禁与权限模型。

### 3.6 智谱 CodeGeeX

- `[厂商自述·codegeex.cn 首页]` 定位仍是"智能编程助手"：代码生成与补全、代码翻译、自动加注释、智能问答、解释/修 bug；CodeGeeX4-ALL-9B 权重开源。
- **明确发现**：首页**没有任何自主 agent / 任务编排 / 多文件工程级自动化**的宣称 —— 国内主流产品并非都在做全自动化。

### 3.7 月之暗面 Kimi（Kimi Code CLI）

- `[一手·moonshotai.github.io/kimi-code 文档首页 + github.com/MoonshotAI/kimi-cli README]`
  - 旧版 Kimi CLI（Python）**已归档、不再维护**，被 **Kimi Code CLI** 取代（`github.com/MoonshotAI/kimi-code`，安装 `curl … code.kimi.com/kimi-code/install.sh`、`npm i -g @moonshot-ai/kimi-code`、`brew install kimi-code`），旧数据 `~/.kimi/` 可通过 `kimi migrate` 迁移且原数据不被修改。
  - 旧 README 仍准确描述了定位：「an AI agent that runs in the terminal… read and edit code, execute shell commands, search and fetch web pages, and **autonomously plan and adjust actions during execution**」。
  - Kimi Code CLI 扩展点（新文档首页）：**Agent Skills**（把团队工作流打包成可调用 skill）、**Hooks**（在生命周期检查点注入脚本：格式化、审批、通知）、**Sub-agents**（隔离上下文并行派发，主线程保持干净）、**MCP**；产品特性：单二进制安装、毫秒启动、**视频输入**（拖入录屏，agent 读帧后行动）、精修 TUI；支持 **ACP**，可在 Zed / JetBrains 的 agent panel 里作为 agent server（`kimi acp`）。
  - 权限模型、评审、合入红线：未公开文档（`[未验证]`）。

---

## 4. 可直接抄进我们自己设计的机制（M 清单）

| # | 机制 | 来源 | 为什么值得抄 |
|---|---|---|---|
| M1 | **权限三层规则 deny > ask > allow，先命中者胜，规则进版本库** | Claude Code `/permissions` | 规则引擎比"模型自觉"可靠；顺序固定=可预测；`.claude/settings.local.json` 落在仓库根使规则跨会话/worktree 生效 |
| M2 | **"提示词不是红线，hook 才是红线"**：需要永远成立的规定必须实现为执行层硬拦截（`PreToolUse`） | Claude Code 设计原则原文 | 这是完全自动化 agent 的第一性边界；CLAUDE.md/skill 里的"never edit .env"只是请求 |
| M3 | **沙箱 + 分类器 + 允许清单三件套**决定"要不要打断人" | Cursor Run Modes；Claude Code `auto` 模式（后台分类器查 shell/网络是否与请求一致） | 比"全问"和"全放"都强：低风险直达、高风险拦人 |
| M4 | **环境先定义再跑**：agent 任务的环境必须是文件（setup steps / blueprints / startup commands / `.junie/demo.md`），且**人评审过**才用于构建沙箱 | Copilot `copilot-setup-steps.yml`；Devin blueprints；Junie `.junie/vms/` | 环境不可复现 = 自动化不可审计 |
| M5 | **分层规则文件 + 路径作用域**：全局/用户/仓库/子目录，按 glob 或 path frontmatter 才加载 | Cursor `.cursor/rules/*.mdc`；Claude Code 四级 CLAUDE.md + `.claude/rules/` paths；Trae Rules | 长文档全塞会稀释注意力；按需加载既省 context 又准确 |
| M6 | **记忆双轨：人写约定 + agent 自写记忆，且都给容量上限** | Claude Code（CLAUDE.md vs auto memory，每会话 200 行/25KB）；Devin（Knowledge→Skills） | "无限记忆"是陷阱；上限 + 分层才是工程解 |
| M7 | **注入上限用字节裁**：AGENTS.md 只注入开头 16 KiB，超出给截断提示 | Devin | 逼迫把关键指令写前面；同时避免 context 爆炸 |
| M8 | **独立 context 的 subagent 只回摘要**，可 preload skills、可 fork 会话、可各自维护记忆 | Claude Code subagents；Kimi Code CLI sub-agents；Copilot dynamic workflows | 并行自动化必须靠 context 隔离，否则主线程被噪声淹没 |
| M9 | **计划物化为文档、人编辑批准后才实现**：计划落在仓库里可提交 | Junie `.junie/plans`（需求/技术设计/交付阶段/测试策略四页签）；Comate Spec 模式 | 把"对齐"从对话变成可评审工件，直接消灭"自信地做错事" |
| M10 | **验证要显式裁决，不接受"进程正常退出"**：agent 必须输出 PASS/FAIL，非 PASS 一律算失败 | Junie `/demo` CI（"a completed agent process does not tell you whether a check passed"） | 完全自动化里最容易被忽略的坑：退出码 ≠ 验证通过 |
| M11 | **低置信动作降级为建议 + 强制记录 rationale** | Copilot Automations | 让"半自动"可控可回看，而不是二值开关 |
| M12 | **自带评审者且复用工程上下文**：评审规则读仓库文件（`BUGBOT.md`），评审用同一套构建/测试/约定 | Cursor Agent Review + Bugbot；Junie `/review`；Copilot code review 复用 setup steps | agent 自审要成立，前提是评审者共享同一份上下文与规则 |
| M13 | **能力插件化分发**（skills/hooks/MCP/subagents 打包，可跨 surface 复用） | Claude Code plugins；Devin plugins（personal/org/enterprise）；Kimi Skills+Hooks；Trae 智能体市场 | 自动化能力要能沉淀成组织资产，而不是每次重新提示 |
| M14 | **ephemeral 环境 + 分支归 agent、合入归人** | Copilot cloud agent（agent 建分支/commit/push/开 PR）；Cursor multi-repo 各开 PR | 这是当前工业界的"自动化上限位置"，也是最容易照抄的安全姿势 |
| M15 | **可回滚快照与 git 解耦** | Cursor checkpoints（只回滚文件、不回滚对话） | 自动化高频试错需要"后悔药"，但它不该污染 git 历史 |

---

## 5. 它们刻意「不自动化」的部分（N 清单）

| # | 不自动化的内容 | 证据 |
|---|---|---|
| N1 | **合并（merge）与"这改动能不能上线"的判断** | Copilot：`you remain responsible for … reviewing the agent's work`；Junie：「You decide whether the change is ready to ship」；Devin：「keeping human engineers in control」；华为 CodeArts 把合入放在 MR 工作流 |
| N2 | **目标与约束的定义** | Copilot 明说 goal/constraints 由人定义；Devin 要求先 Ask Devin 摸清代码库并生成 high-context prompt |
| N3 | **模糊/探索性任务** | Copilot Autopilot 文档警告 vague 任务会跑偏；Devin「excluding extremely difficult tasks」、三小时经验法则 |
| N4 | **跨"写操作"的自动化越界** | Copilot Automations 明确：不覆盖人手动改动、不 push、不开 PR；低置信转 suggestion |
| N5 | **权限提权与密钥** | Claude Code `bypassPermissions` 只许容器/VM，且企业可 managed settings 禁用；secrets 一律显式配置（Copilot secrets/variables、Devin Secrets/VPN） |
| N6 | **受保护路径与不可自动批准的动作** | Claude Code：受保护路径 `.git`/`.claude` 单独控制，另有"任何模式都不自动批准"的动作集合；`dontAsk` 下 AskUserQuestion、标记需人工的 MCP 工具一律拒绝 |
| N7 | **发布/部署动作**（以显式配置步骤存在，而不是 agent 自主决定） | Devin 的 TestFlight 上传、CodeArts 的流水线部署、Cursor 的 Rollouts 都是配置项/企业能力 |
| N8 | **无界记忆写入** | Claude Code auto memory 每会话只载前 200 行/25KB；Devin AGENTS.md 注入上限 16 KiB；CLAUDE.md 官方建议 <200 行 |
| N9 | **"计划"跳过评审直接实现** | Junie Plan 模式必须 Confirm 才实现；Comate Spec 模式把 PRD/任务拆分作为交付物 |

**可提炼的一条设计律**：所有厂商的自动化边界都落在同一处 —— **不可逆 / 影响他人 / 需要担责的动作留给人**（合并、发布、授权、目标定义）；可逆 / 仅影响本工作区的动作（读、改、跑测试、建分支、提交、开 PR）才交给 agent。我们的「完全自动化」如果想再往前一步，必须为这些不可逆动作**造出可回滚的替代物**（沙箱重放、影子分支、灰度、显式裁决），而不是删掉人工卡点。

---

## 6. 资料来源清单

全部抓取日期 **2026-10-26**。

### 一手（官方文档 / 官方仓库 / 官方博客）

1. GitHub Copilot（cloud agent 概念、自主性三档、环境定制、Autopilot、Automations）— https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-on-github 及同目录 `agent-powered-workflows-and-operations/*`、`customize-copilot/*`
2. Cursor（Agent 三件套/Projects/Rules 四层/Cloud Agents/Automations/Run Modes/Agent Review）— https://cursor.com/docs （索引 https://cursor.com/llms.txt ，具体页 `/docs/rules.md`、`/docs/cloud-agent.md`、`/docs/agent/security/run-modes.md`、`/docs/agent/agent-review.md`、`/docs/cloud-agent/automations.md`）
3. Claude Code 记忆与扩展层（CLAUDE.md 四级 scope、auto memory、Skills/Subagents/Hooks/Plugins、边界原则原文）— https://code.claude.com/docs/en/memory ，https://code.claude.com/docs/en/features-overview
4. Claude Code 权限（权限表、`/permissions` 三类规则与 deny>ask>allow 顺序、6 种 mode、受保护路径、managed settings 禁用项、"rules are enforced by Claude Code, not by the model"）— https://code.claude.com/docs/en/permissions
5. Claude Code 认证与企业登录策略 — https://code.claude.com/docs/en/iam
6. AGENTS.md 规范（"README for agents"、60k+ 项目、刻意与 README 分离）— https://agents.md
7. OpenAI Codex 官方仓库（定位、surface、docs 目录；`sandbox.md`/`agents_md.md` 为存根）— https://github.com/openai/codex
8. Devin（定位与三小时法则、Ask Devin 先行、AGENTS.md 16 KiB 注入、Knowledge→Skills in Plugins、plugins 三档作用域、blueprints）— https://docs.devin.ai （`get-started/devin-intro`、`essential-guidelines/when-to-use-devin`、`onboard-devin/knowledge-onboarding`、`onboard-devin/agents-md`、`essential-guidelines/sdlc-integration`、`product-guides/plugins`）
9. JetBrains Junie（GA 能力：Plan 模式与 `.junie/plans`、agentic debugging、远程异步、`/review`、ACP/IDE 工具复用、LLM-agnostic/BYOK/本地模型）— https://blog.jetbrains.com/junie/2026/06/junie-coding-agent-out-of-beta/
10. JetBrains Junie `/demo`（Docker 环境、Xvfb/xdotool/ffmpeg、HTML+截图+视频、CI `--demo`、**显式 PASS/FAIL 裁决**、1500+ PR/2100+ 视频、22 场景冒烟）— https://blog.jetbrains.com/junie/2026/09/junie-demo/
11. JetBrains Junie Local（`/local`、本机模型、代码不出机器、模型融合与评测）— https://blog.jetbrains.com/junie/2026/10/junie-local-rtx-spark/ ，https://blog.jetbrains.com/junie/2026/09/smarter-local-al/
12. Kimi Code CLI 文档首页（Skills / Hooks / Sub-agents / MCP / 视频输入 / 单二进制）— https://moonshotai.github.io/kimi-code/en/
13. Kimi CLI 归档公告与新项目指引（旧 Python CLI 已归档、迁移 `kimi migrate`、ACP/Zed/JetBrains 接入、自主规划原话）— https://github.com/MoonshotAI/kimi-cli （README），新仓库 https://github.com/MoonshotAI/kimi-code
14. 华为云码道 CodeArts 产品页（码道代码智能体 Web Agent Beta、需求/代码托管 MR/检查/流水线/测试/制品）— https://www.huaweicloud.com/product/codearts.html

### 厂商自述（官网营销页，能力介绍级，无技术细节）

15. 字节 Trae（Agent 模式多项目多 Agent、SOLO 模式、TRAE Rules、自定义智能体与市场、MCP）— https://www.trae.com.cn/ ，https://www.trae.com.cn/solo ，https://www.trae.ai/
16. 阿里通义灵码 / Qoder CN（编程智能体、终端命令自主执行、工程自动感知、RepoWiki、Skills 和 Sub-Agent、Lingma IDE）— https://lingma.aliyun.com/
17. 腾讯 CodeBuddy（插件/IDE/CLI 三端、Figma 转代码、PRD 生成、CloudBase/Supabase 集成、任务拆解执行）— https://copilot.tencent.com/
18. 百度 Comate 文心快码（多智能体调度、Code/Mission/Spec/Plan 模式、PRD→任务拆分→验证→交付总结）— https://comate.baidu.com/zh
19. 智谱 CodeGeeX（补全/翻译/注释/问答、CodeGeeX4-ALL-9B 开源；**无自主 agent 宣称**）— https://codegeex.cn/

---

## 7. 缺口与未验证清单

| 缺口 | 原因 | 影响 |
|---|---|---|
| **Google Jules 全部内容** | `jules.google/`、`/docs`、`developers.googleblog.com/en/introducing-jules/` 全部 `ERR_CONNECTION_TIMED_OUT`（web_fetch 与真浏览器均失败） | 本报告对 Jules 不做任何事实断言，需换网络后补抓 |
| **OpenAI Codex cloud agent / AGENTS.md 注入规则 / sandbox 策略** | `developers.openai.com` 对抓取端稳定 403（Akamai），`r.jina.ai` 超时；官方仓库对应 docs 为存根 | Codex 只能覆盖"本地 CLI + surface"层，云端能力未验证 |
| **字节 Trae 技术文档** | `docs.trae.ai/ide/what-is-trae` 标题可达、正文客户端渲染为空（多次等待/滚动仍空） | Trae 只有营销口径（§3.1） |
| **腾讯 CodeBuddy 技术文档** | 官网只到能力介绍层，文档站需登录/未定位到 | §3.3 为营销口径 |
| **国内产品的权限模式、评审归属、合入策略** | 通义灵码旧文档路径 404；Comate/Trae/CodeBuddy 未公开此类文档 | §3 大部分机制字段标"未见公开说明" |
| **Cursor Bugbot / Security Agents / PR Routing & Approval / Rollouts 细节** | 仅从 `llms.txt` 索引确认页面存在，未逐个抓取 | 只按"能力存在"记录，未做机制断言 |

---

## 8. 对我们「完全自动化 AI 编程智能体」的直接建议

1. **红线一律实现为执行层拦截**（M1/M2）：权限规则进仓库、hook 硬拦、分类器兜底；提示词只作引导。
2. **任务开始前必须先有可评审的计划产物**（M9）：我们的自动化入口应是 issue/spec → 计划文档 → 人批准（或命中预批准模板）→ 实现。
3. **环境即代码**（M4/M14）：ephemeral 沙箱由仓库内文件定义，人为该文件把关；agent 只拿分支写权限，不拿合并权限。
4. **验证必须显式裁决**（M10）：任何"测试通过"都要 agent 输出结构化 PASS/FAIL + 证据（日志/截图/视频），否则一律算失败。
5. **记忆双轨 + 硬上限**（M6/M7/M8）：人写约定（AGENTS.md 一类）+ agent 自写记忆（限行数/字节），子任务 context 隔离只回摘要。
6. **不可逆动作的替代物**：合并/发布这类动作不自动做，但可以自动化"影子分支 + 灰度 + 可回滚快照 + 演示录像"，把人的决策成本压到最低（这是当前所有厂商留白的空间，也是我们唯一能超越的地方）。
