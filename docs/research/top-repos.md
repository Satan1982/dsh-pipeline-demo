# GitHub 上 star 最多的 AI 编程 / coding agent 开源项目：架构与工程经验

抓取日期：**2026-10-26**（star / fork / 最后 push 均取当日 `api.github.com` 值）
范围：任务指定的 14 个候选（含 AutoGPT / MetaGPT 的编码相关部分）
口径：只写抓取到的原文事实；没抓到证据的判断一律标「未验证」。

---

## 0. 先给结论（可直接变工程动作）

| # | 工程动作 | 出处 | 为什么 |
|---|---|---|---|
| 1 | 上下文用 **repo map（代码图排序 + token 预算）**，不要整仓塞 prompt | Aider | 图排序后填进 active token budget，`--map-tokens` 默认 **1k** |
| 2 | 收窄动作空间（ACI）：专用 file viewer、search 只列命中文件、空输出显式回话 | SWE-agent | 论文实测「无 ACI 的基线明显更差」；每轮只显示 100 行 |
| 3 | **验证不交给模型自评**：lint / test 由程序跑，非零退出码驱动下一轮修复 | Aider | `--lint-cmd` / `--test-cmd` / `--auto-test` 的契约就是退出码 |
| 4 | 语法门禁前置：编辑即 lint，语法错不让落盘 | SWE-agent | ACI 第 1 条就是「linter 拦住不合法编辑」 |
| 5 | 沙箱与审批**分层**：执行在容器/OS 沙箱，决策在 policy（风险分级） | OpenHands / Codex CLI / Gemini CLI | OpenHands 默认 `ConfirmRisky`；Codex 把审批做成 RPC 参数；Gemini 用 `tools.core` 白名单 + `tools.exclude` 黑名单（黑名单优先） |
| 6 | 审批点做成**可编程钩子**，能阻断工具调用 | Claude Code | Hooks 有 `PreToolUse` / `PostToolUse` / `Stop` 等，**exit code 2 = 阻断**，exit 0 无输出 = 放行 |
| 7 | 每步可回滚：**shadow git** 快照，回滚同时回滚会话 | Gemini CLI / Roo Code / Cline | Gemini `/restore` 同时恢复文件与会话历史；Roo 用独立 shadow 仓 |
| 8 | 上下文压缩显式管线化 | OpenHands | `CondenserBase` / `RollingCondenser` / `LLMSummarizingCondenser` / `PipelineCondenser`，`max_size` 是触发阈值 |
| 9 | 重试要有硬预算 | SWE-agent | 格式错误模板：连续 2 次格式错就**终止 episode** |
| 10 | 评测外部化：patch 落盘交 harness 打分 | SWE-agent / AutoCodeRover | `preds.json` / `selected_patch.json`，由 SWE-bench 这类外部 harness 判分 |

补充两条**选型事实**（比 star 数更该先看）：
- **star ≠ 活跃**：Roo Code 已于 2026-05-15 停服（仓库只读）；Continue 官方声明仓库 read-only、不再维护；gpt-engineer 最后 push 2025-05-14；Aider 最后 push 2026-05-22。选型必须一起看 `pushed_at`。
- **`anthropics/claude-code` 不含产品源码**：仓库根目录只有 `plugins/` `examples/` `mods/` `CHANGELOG.md` `CLAUDE.md` 等，产品本体闭源。它的 star 数代表「闭源产品的 issue + 插件仓」，不能当开源实现读。

---

## 1. 项目 → star → 关键机制

| 项目 | star（2026-10-26） | 语言 / 现状 | 关键机制（一句话） |
|---|---:|---|---|
| AutoGPT（Significant-Gravitas） | 187,741 | Python/TS，活跃 | 主体已转 AutoGPT Platform（可视化 block 编排）；`classic/` 保留原版 agent：文件访问限定在 `workspace/`，命令执行走 interactive approval |
| Claude Code（anthropics） | 153,343 | TS，**产品闭源**（仓库=插件/issue） | 权限模式（`acceptEdits`/`plan`/`bypassPermissions`…）+ **Hooks 可阻断工具调用** + subagent 独立上下文只回摘要 |
| OpenAI Codex CLI | 130,871 | Rust，活跃 | 审批做成 app-server 协议里的 approval 请求（exec/apply-patch/file-change/permissions）；沙箱按平台分实现（macOS seatbelt、Windows sandbox） |
| Gemini CLI（google-gemini） | 108,379 | TS，活跃 | shadow git checkpoint + `/restore`（文件与会话一起回滚）；`-s` 沙箱（docker/podman/sandbox-exec/runsc/lxc）；`tools.core` 白名单、`tools.exclude` 黑名单优先 |
| OpenHands（原 OpenDevin） | 91,803 | TS，活跃 | SDK 分层：agent / events / tool-system / **condenser** / **security**；默认策略 `ConfirmRisky`（LOW/MEDIUM/HIGH/UNKNOWN 分级）；运行时可带 Docker 沙箱 |
| MetaGPT（FoundationAgents） | 71,014 | Python，2026-01-21 最后 push | `Code = SOP(Team)`：PM / architect / PM / engineer 多角色按 SOP 流水线产出代码 |
| Cline | 70,851 | TS，活跃 | Plan/Act 双模式 + **每处编辑与命令都要审批**（可开 auto-approve）+ checkpoints 撤销 + 边写边盯 linter/compiler 错误 |
| gpt-engineer（AntonOsika） | 55,004 | Python，**2025-05-14 最后 push** | `improve` 模式改已有代码；`bench` 二进制做 agent 基准；README 自荐改用 aider |
| Aider | 49,748 | Python，2026-05-22 最后 push | **repo map**（图排序 + 1k token 预算）+ 每次改动**自动 git commit** + lint/test 自动修复循环 + architect/editor 双模型 |
| Continue | 36,320 | TS，**仓库只读、不再维护** | Agent 模式 + **Plan Mode（只读探索）**；MCP / rules / context providers |
| Roo Code | 24,263 | TS，**2026-05-15 停服、只读** | Code/Architect/Ask/Debug/Custom 五模式；**shadow git checkpoint**（改文件前快照，可回滚代码+会话）；分动作类别 auto-approve（带 risk level） |
| SWE-agent | 20,635 | Python，活跃 | **ACI**（Agent-Computer Interface）：编辑即 lint、专用 100 行 viewer、search 只列文件、空输出显式提示；格式错误 2 次终止 |
| Devon（entropy-research） | 3,450 | Python，2025-05-26 最后 push | AST 建图 + 图检索（`codebase_graph` / `graph_construction/{python,typescript}`）；自述非 Python 支持有限 |
| AutoCodeRover（AutoCodeRoverSG） | 3,102 | Python，活跃 | 三段流水线：code search 取上下文 → 生成 patch →（有测试时）**统计式故障定位**；v20240620 在 SWE-bench Verified **46.20%**、每任务 **<$0.7 / <7 分钟** |

> 注：`All-Hands-AI/OpenHands` 已 301 到 `OpenHands/OpenHands`；`gpt-engineer-org/gpt-engineer` 已 301 到 `AntonOsika/gpt-engineer`；`nus-apr/auto-code-rover` 现为 `AutoCodeRoverSG/auto-code-rover`。

---

## 2. 逐项目拆解（七问：计划-编辑-验证 / 测试与 CI / 上下文检索 / 沙箱与权限 / 防假成功 / HITL / 重试与成本）

### 2.1 Aider（49,748）

- **计划—编辑—验证**：`architect` 模式把一次请求拆成两次模型调用——主模型先 propose 方案，再由 **editor model** 把方案翻成具体文件编辑（`/chat-mode architect`、`--architect`）。普通 code 模式一个模型直接改文件。
- **测试/CI 回路**：内置多语言 linter 自动跑；`--lint-cmd <cmd>` 自定义（命令接收文件名、**非零退出码=有错**）；`--test-cmd <cmd>` + `--auto-test` 在每次改动后跑测试并让模型修；`/test <cmd>` 手动触发，`/run <cmd>` 跑任意命令。示例契约：`--test-cmd "dotnet build && dotnet test"`。
- **上下文检索**：repo map 用 **graph ranking algorithm** 在代码图上排序，结果塞进 **active token budget**，预算由 `--map-tokens` 控制，**默认 1k**；语言支持走 tree-sitter。
- **沙箱与权限**：文档未见沙箱层——aider 直接改本地工作树。**安全网是 git**：每次改动自动 commit 带提交信息，`/undo`、`git diff` 就是回滚与审计界面。
- **防假成功**：不靠模型自评，靠退出码（lint/test 的进程退出状态）。这是全文最省事的一条「假成功」防线。
- **HITL**：默认每次交互式确认；`/run`、`/test` 输出会回流给模型。细粒度审批机制（按命令逐条 approve）**未验证**。
- **重试与成本**：architect/editor 双模型本身就是成本分层（贵的模型只做规划，编辑交给便宜模型）；`--map-tokens` 是显式的上下文预算旋钮。

### 2.2 OpenHands（91,803）

- **架构分层**（`docs.openhands.dev/sdk/arch/*`）：`agent` / `agent-server` / `conversation` / `events` / `tool-system` / `condenser` / `security` / `skill` / `workspace` / `mcp`。客户端与服务端分离（README 提到 Agent Server API 由 SDK 实现，Canvas 是 TypeScript 客户端）。
- **沙箱**：README 给三种跑法——① 无沙箱；② 单 Docker sandbox；③ 多 Docker sandbox；并明确「没有沙箱时隔离不被强制」。
- **权限 / 审批**：`security` 层是**可插拔分析器 + 策略**：
  - 分析器：`SecurityAnalyzerBase`（契约 `security_risk()`）、`LLMSecurityAnalyzer`（把 LLM 在 action 参数里给的风险值当输入）、`NoOpSecurityAnalyzer`（恒 UNKNOWN）。
  - 策略：`AlwaysConfirm`（全确认）、`NeverConfirm`（全自动）、**`ConfirmRisky`（默认）**；风险级别 LOW/MEDIUM/HIGH/UNKNOWN，`confirm_unknown` 可配。
  - 落到 API：`set-conversation-confirmation-policy`、`set-conversation-security-analyzer`、`respond-to-confirmation`。
- **上下文压缩**：`CondenserBase` 体系——`NoOpCondenser`、`RollingCondenser`、`LLMSummarizingCondenser`、`PipelineCondenser`；`max_size` 是**事件数阈值**，到了就触发压缩。
- **防假成功**：抓到的证据只有导航里的 `Metrics Tracking` / `Observability & Tracing` 两项，具体判分方式**未验证**。
- **HITL**：确认策略层就是 HITL 的开关——`ConfirmRisky` 让「高危动作」停下来等人，其余放行。

### 2.3 SWE-agent（20,635）

- **ACI 是本项目的核心论点**（`docs/background/aci.md`，论文 arXiv 2405.15793）：同一模型、不同接口，效果差很多。四条具体设计：
  1. 编辑命令**触发 linter**，语法不合法就不让这次编辑生效；
  2. 专用 file viewer，每轮只显示 **100 行**，带上下滚动与文件内搜索（禁止裸 `cat`）；
  3. 全目录搜索命令**只列「至少命中一次」的文件**，因为给模型更多上下文反而更乱；
  4. 命令无输出时回一句 `Your command ran successfully and did not produce any output.`（消灭「空=失败」的误判）。
- **重试预算**：三种模板 `next_step_template` / `next_step_no_output_template` / `format_error_template`；格式错时若下一轮改对，该轮从历史里**移除**；**连续两次格式错则终止 episode**。
- **工具组织**：tool bundles（`bash` + 文件查看器 + 编辑器，各自 `bin/` 可执行）。
- **测试/CI 与评测**：batch 模式默认在 **Docker sandbox** 里跑，`--num_workers` 并行，所有 patch 落 `preds.json`，可直接提交 `sb-cli` 拿分。
- **防假成功**：agent 只负责产出 patch，**判分在外部 harness**（SWE-bench），不自己说自己修好了。
- **成本**：`num_workers` 并行 + 容器化，是吞吐向的成本控制；单任务预算需外部设定（**未验证**其默认限额）。

### 2.4 Cline（70,851）

- **计划—编辑—验证**：**Plan / Act 双模式**——Plan 模式只探索、问澄清问题、给方案；确认后切 Act 执行。
- **测试/CI**：直接在自己终端跑命令并**实时看输出**；长跑进程（dev server）继续跟，抓编译错误、测试失败、崩溃。写代码过程中持续消费 **linter/compiler 错误**并修（missing import、类型不匹配、语法错）。
- **权限 / HITL**：**每处文件编辑与每条终端命令都需要批准**；可开 auto-approve 让它自主跑。改动以 diff 呈现，可改可撤。
- **回滚**：**checkpoints** 跟踪所有改动，可撤销 agent 的工作。
- **上下文**：读项目结构、理解文件关系；`.clinerules` 放团队约定（编码规范、架构约定、部署流程、测试要求），CLI / VS Code / JetBrains 三端共用。
- **扩展性**：MCP + 插件 SDK（注册工具与生命周期钩子：日志、审计、策略）；另有 coordinator + 专家 agent 的 team 模式（子任务分派，team 状态跨会话保留）。
- **无头/CI 用法**：`cline "Run tests and fix any failures"`，CLI 支持 headless。

### 2.5 Continue（36,320）

- **现状**：`continuedev/continue` 官方声明 **read-only、不再活跃维护**，只发了最后一个 2.0.0（VS Code / CLI / JetBrains）。star 数是冻结值。
- **计划/编辑**：Agent 模式 + **Plan Mode**（文档标题即「Safe, Read-Only Code Exploration」）。
- **上下文/规则**：MCP servers、rules、context providers（`@Codebase`、`@Docs` 已标 deprecated）。
- **沙箱/审批**：未抓到具体机制，**未验证**。

### 2.6 Roo Code（24,263）

- **现状**：2026-05-15 停服，仓库只读；社区 fork 为 ZooCode。它是从 Cline 分出来的。
- **模式即计划层**：Code / Architect（规划系统、规格、迁移）/ Ask / Debug（加日志、隔离根因）/ Custom，另有 Boomerang Tasks 做任务分解。
- **回滚**：**shadow git 仓库**（与你的主版本库分离）在**文件被修改前**自动快照；restore 有三种粒度，最狠的一种**同时重置代码与会话**（需二次确认、不可撤销）；`.gitattributes` 里的 Git LFS 规则会被读入 checkpoint 排除项，避免把大资产塞进 shadow 仓。
- **权限 / HITL**：auto-approve **按动作类别分项开关**（读、写文件、命令、模式切换、MCP 工具…），每项标风险等级；写文件还有 write delay 控制（延迟期间 Roo 会看 VS Code Problems 面板）。

### 2.7 Claude Code（153,343）

- **前提**：仓库**不含产品源码**（根目录 `plugins/ examples/ mods/ CHANGELOG.md CLAUDE.md` 等），以下机制全部来自官方文档页，属「文档事实」而非源码事实。
- **权限模式**：文档里出现 `acceptEdits`（自动接受文件编辑与常见文件系统命令）、`plan`（规划态对命令另有门禁）、`bypassPermissions`（跳过提示）；另有 `auto` / `dontAsk` 两种更新形态（`dontAsk` 从不提示、直接拒绝）。工作目录之外、以及不在工作目录内的文件解析结果，`acceptEdits` 不会自动批准。
- **Hooks 是审批的可编程平面**：事件含 `PreToolUse` / `PostToolUse` / `Stop` / `SessionStart` / `UserPromptSubmit` / `SubagentStop` / `Notification` / `PreCompact`；**exit code 2 = 阻断该动作**，exit 0 且无输出 = 无决定、继续走常规权限流。
- **上下文隔离**：subagent 在**自己的 context window** 里干活，只把摘要回给主会话；Plan subagent 让主会话保持只读、把探索输出留在子上下文里。
- **防假成功**：未抓到「程序化验证」的机制描述，**未验证**；文档层面能确认的是审批与钩子能拦住危险动作。

### 2.8 OpenAI Codex CLI（130,871）

- **语言**：仓库主实现是 **Rust**（`codex-rs/`）。
- **沙箱与审批在仓库里是显式协议**（`codex-rs/app-server-protocol/schema/json/`）：`ExecCommandApprovalParams`、`ApplyPatchApprovalParams`、`FileChangeRequestApprovalParams`、`PermissionsRequestApprovalParams`（各有 Response）。即**每个动作类别一个 approval 请求**，客户端负责决定放不放。
- **平台沙箱实现**：`codex-rs/cli/src/debug_sandbox/seatbelt.rs`（macOS Seatbelt）、`codex-rs/app-server-protocol/src/protocol/v2/windows_sandbox.rs` + `codex-rs/app-server/src/request_processors/windows_sandbox_processor.rs`（Windows）。Linux 侧实现**未验证**。
- **文档**：`docs/sandbox.md` 正文只有一句「Sandbox & approvals → developers.openai.com/codex/security」；该站对 curl 返回 **403**，因此审批语义细节**未取到原文**。`docs/agents_md.md`（AGENTS.md 约定）与 `docs/execpolicy.md` 同样是指向外部文档的存根。
- **CI / headless**：`docs/exec.md` 存在（存根），说明有非交互执行入口。

### 2.9 Gemini CLI（108,379）

- **回滚**：**Checkpointing**——在任何 AI 文件修改**之前**，在**独立的 shadow git 仓库**里提交一个快照（不干扰你自己的仓库）；`/restore` 可把项目文件**和会话历史**一起回滚；数据全部本地存放。
- **沙箱**：`-s` / `--sandbox`，或 `GEMINI_SANDBOX=true|docker|podman|sandbox-exec|runsc|lxc`，或 `settings.json` 的 `{"tools":{"sandbox":true}}`（优先级：命令行 > 环境变量 > 配置文件）。
- **权限**：**Trusted Folders 默认关闭**，开启后首次在某目录运行会弹信任对话框；shell 工具有 confirmation 环节；`tools.core` 是**全部内置工具**的白名单（可按命令前缀），`tools.exclude` 是黑名单，**黑名单优先**；`tools.shell.inactivityTimeout` 控制等待输出的秒数。
- **上下文**：`GEMINI.md` 做持久上下文（README 链接 Context Files 文档）。
- **CI**：仓库带 `.github/workflows/ci.yml`。

### 2.10 gpt-engineer（55,004）

- **形态**：最老的一代「prompt → 整仓生成」。`improve` 模式在已有代码目录里按 `prompt` 文件改进。
- **测试/CI**：不在回路里。README 提供 `bench` 二进制 + `gpte-bench-template` 模板，用公开数据集跑 agent 基准——这是**离线评测**，不是运行时验证。
- **沙箱/审批**：README 未见，**未验证（大概率没有）**。
- **状态**：最后 push **2025-05-14**；README 明确写「如果你在找一个维护良好的可 hack 的 CLI，看 aider」。

### 2.11 Devon（3,450）

- **上下文检索**：仓库里是**AST 建图 + 图检索**——`devon_agent/tools/retrieval/codebase_graph.py`、`devon_agent/tools/retrieval/graph_visualization.py`、`devon_agent/tools/semantic_search/code_graph_manager.py`、`devon_agent/tools/semantic_search/graph_construction/languages/{python,typescript}/*_parser.py`。
- **自述局限**（README）：非 Python 语言功能很少；有时得手动指定要改哪个文件；**local mode 不好用**，建议别开。
- **沙箱/审批/验证回路**：README 未给，**未验证**。最后 push **2025-05-26**，实质停更。

### 2.12 AutoCodeRover（3,102）

- **流水线**（README）：① **Context retrieval**——给 LLM 一组 **code search API** 让它自己在仓库里导航取证；② **Patch generation**——基于取到的上下文写 patch；③ 有测试套件时，额外用**统计式故障定位（statistical fault localization）**把修复率再抬高。
- **成绩与成本（同页给出的数字）**：v20240620 在 **SWE-bench Verified 46.20%**、full SWE-bench **24.89%**；SWE-bench lite **30.67%（pass@1）**；**每任务 < $0.7、< 7 分钟**。
- **评测方式**：Docker 镜像 + SWE-bench 模式跑；patch 成功则写 `selected_patch.json`。
- **防假成功**：靠外部 harness（SWE-bench 测试）+ 测试驱动的故障定位，不用模型自评。

### 2.13 AutoGPT（187,741）／MetaGPT（71,014）的编码相关部分

- **AutoGPT**：主体已迁到 **AutoGPT Platform**（可视化 builder，连 block、分支、控步骤；hosted 版是付费服务）。**`classic/` 仍是 MIT**，保留三件套：原版 agent、**Forge**、**agbenchmark**。
  - `classic/` 的 agent 有一条值得抄的约束：**agent 的文件访问被限制在各自的 `workspace/` 子目录**。
  - 命令执行走 **interactive approval**，用户可以按不同**授权范围**批准（README 只到这一层，具体 scope 枚举**未逐字验证**）。
- **MetaGPT**：`Code = SOP(Team)`——内置 product manager / architect / project manager / engineer 等角色，把「一家软件公司的流程」编成 SOP 让 LLM 团队跑。编码能力来自 Engineer 角色；另有 `DataInterpreter` 角色做数据类任务。最后 push **2026-01-21**（比继续活跃的项目冷）。
- **说明**：这两个仓库的 star 数反映的是「自主 agent / 多 agent 框架」叙事，不是「coding agent 工程质量」；拿来对标 Aider/SWE-agent 会高估。

---

## 3. 横向归纳：七问对照

| 维度 | 做得最狠的 | 具体做法 |
|---|---|---|
| 计划层 | Aider / Cline / Roo | architect 双模型；Plan/Act 分离；Architect 模式独立 |
| 编辑层 | SWE-agent | 编辑前 lint 门禁；viewer 限 100 行；search 只列文件名 |
| 验证层 | Aider / SWE-agent / AutoCodeRover | lint/test 退出码驱动；外部 harness 判分；测试驱动故障定位 |
| 上下文 | Aider / OpenHands / Claude Code | repo map + token 预算；condenser 管线；subagent 独立窗口只回摘要 |
| 沙箱 | OpenHands / Codex / Gemini | Docker 容器；平台级沙箱（seatbelt / windows sandbox）；多种 sandbox 后端 |
| 审批 | Claude Code / Codex / Gemini / Roo | Hooks 可阻断；approval RPC；白名单+黑名单（黑名单优先）；按动作类别分项 |
| 回滚 | Gemini / Roo / Cline / Aider | shadow git 快照（连会话一起回滚）；checkpoint；每次改动 auto-commit |
| 重试/成本 | SWE-agent / AutoCodeRover / Aider | 连续 2 次格式错终止；$0.7/7min 预算标定；双模型成本分层 |

**最值得抄的三条「防假成功」**：
1. 让**进程退出码**说话（Aider 的 `--test-cmd` / `--lint-cmd`）；
2. 让**外部 harness**说话（SWE-agent 的 `preds.json` → SWE-bench；AutoCodeRover 的 `selected_patch.json`）；
3. 让**语法/静态检查**在落盘前说话（SWE-agent 的编辑即 lint）。

模型说「我修好了」在这三个项目里都不是判据。

---

## 4. 未验证项（明确列出，避免被当结论用）

- OpenAI Codex 的审批语义细节（`developers.openai.com/codex/security` 抓取 403，仅有仓库存根）。
- Codex 的 Linux 沙箱实现（只验证了 macOS seatbelt 与 Windows sandbox 路径存在）。
- OpenHands 的「假成功」防线具体实现（只看到 Metrics/Observability 导航项）。
- Continue 的沙箱与审批机制。
- Devon 的沙箱/验证回路（README 未写）。
- gpt-engineer 是否有任何审批层（README 未写）。
- AutoGPT classic 的 approval scope 枚举细节。

---

## 5. 资料来源（全部抓取于 2026-10-26）

**仓库元数据**（star/fork/pushed_at，`api.github.com/repos/<owner>/<repo>`）
- https://api.github.com/repos/Significant-Gravitas/AutoGPT — 187,741
- https://api.github.com/repos/anthropics/claude-code — 153,343
- https://api.github.com/repos/openai/codex — 130,871
- https://api.github.com/repos/google-gemini/gemini-cli — 108,379
- https://api.github.com/repos/OpenHands/OpenHands — 91,803（`All-Hands-AI/OpenHands` 301）
- https://api.github.com/repos/FoundationAgents/MetaGPT — 71,014
- https://api.github.com/repos/cline/cline — 70,851
- https://api.github.com/repos/AntonOsika/gpt-engineer — 55,004（`gpt-engineer-org/gpt-engineer` 301）
- https://api.github.com/repos/Aider-AI/aider — 49,748
- https://api.github.com/repos/continuedev/continue — 36,320
- https://api.github.com/repos/RooCodeInc/Roo-Code — 24,263
- https://api.github.com/repos/SWE-agent/SWE-agent — 20,635
- https://api.github.com/repos/entropy-research/Devon — 3,450
- https://api.github.com/repos/AutoCodeRoverSG/auto-code-rover — 3,102（`nus-apr/auto-code-rover` 改名）

**Aider**
- https://github.com/Aider-AI/aider/blob/main/README.md
- https://aider.chat/docs/repomap.html（graph ranking、token budget、`--map-tokens` 默认 1k）
- https://aider.chat/docs/usage/lint-test.html（`--lint-cmd` / `--test-cmd` / `--auto-test` / `/test` / `/run`、退出码契约）
- https://aider.chat/docs/usage/modes.html（architect 双模型：主模型 propose、editor model 落地）

**OpenHands**
- https://github.com/OpenHands/OpenHands/blob/main/README.md（三种沙箱跑法、Agent Server API / Canvas 分层）
- https://docs.openhands.dev/sdk/arch/security（`SecurityAnalyzerBase` / `LLMSecurityAnalyzer` / `NoOp`；`AlwaysConfirm` / `NeverConfirm` / `ConfirmRisky`；risk level 与 `confirm_unknown`）
- https://docs.openhands.dev/sdk/arch/condenser（`NoOpCondenser` / `RollingCondenser` / `LLMSummarizingCondenser` / `PipelineCondenser`，`max_size` 阈值）
- https://docs.openhands.dev/sdk/arch/tool-system 、 https://docs.openhands.dev/sdk/arch/agent
- https://docs.openhands.dev/sitemap.xml（确认 arch 分层与 confirmation/security API 页存在）

**SWE-agent**
- https://github.com/SWE-agent/SWE-agent/blob/main/README.md
- https://swe-agent.com/latest/background/aci/ ← 源文件 https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md（四条 ACI 设计、100 行 viewer、空输出提示、arXiv 2405.15793）
- https://github.com/SWE-agent/SWE-agent/blob/main/docs/config/templates.md（三种模板、连续 2 次格式错终止）
- https://github.com/SWE-agent/SWE-agent/blob/main/docs/usage/batch_mode.md（Docker 后端、`--num_workers`、`preds.json`、`sb-cli` 提交）
- https://github.com/SWE-agent/SWE-agent/blob/main/docs/config/tools.md（tool bundles）

**Cline**
- https://github.com/cline/cline/blob/main/README.md（Plan/Act、逐次审批与 auto-approve、checkpoints、linter/compiler 实时修复、`.clinerules`、MCP、team 模式、headless CLI）

**Continue**
- https://github.com/continuedev/continue/blob/main/README.md（read-only、不再维护、2.0.0 终版）
- https://docs.continue.dev/ide-extensions/agent/plan-mode（Plan Mode：只读探索）
- https://docs.continue.dev/（Agent / CLI / rules / context providers；`@Codebase`、`@Docs` 标 deprecated）

**Roo Code**
- https://github.com/RooCodeInc/Roo-Code/blob/main/README.md（五种模式；2026-05-15 停服）
- https://roocodeinc.github.io/Roo-Code/features/checkpoints（shadow git、改前快照、三种 restore、.gitattributes/LFS 排除）
- https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions（按动作类别 auto-approve、risk level、write delay 与 Problems 面板）

**Claude Code**（文档事实，非源码）
- https://github.com/anthropics/claude-code（仓库根目录只有 plugins/examples/mods 等）
- https://code.claude.com/docs/en/permissions（`acceptEdits` / `plan` / `bypassPermissions` / `auto` / `dontAsk`）
- https://code.claude.com/docs/en/hooks（`PreToolUse` / `PostToolUse` / `Stop` 等事件；exit code 2 阻断、exit 0 放行）
- https://code.claude.com/docs/en/sub-agents（独立 context window、只回摘要、Plan subagent 让主会话只读）

**OpenAI Codex CLI**
- https://github.com/openai/codex/blob/main/README.md（Rust 实现）
- https://github.com/openai/codex/blob/main/docs/sandbox.md（存根 → developers.openai.com/codex/security，抓取 403）
- https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/schema/json（`ExecCommandApprovalParams` / `ApplyPatchApprovalParams` / `FileChangeRequestApprovalParams` / `PermissionsRequestApprovalParams`）
- https://github.com/openai/codex/blob/main/codex-rs/cli/src/debug_sandbox/seatbelt.rs 、 https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/windows_sandbox.rs
- https://github.com/openai/codex/tree/main/docs（`agents_md.md` / `exec.md` / `execpolicy.md` / `config.md` 均为存根）

**Gemini CLI**
- https://github.com/google-gemini/gemini-cli/blob/main/README.md（GEMINI.md、Checkpointing、Sandboxing 入口、CI badge）
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md（shadow git、改前快照、`/restore` 恢复文件+会话、本地存储）
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md（`-s`、`GEMINI_SANDBOX`、docker/podman/sandbox-exec/runsc/lxc、优先级）
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/trusted-folders.md（默认关闭、首次弹信任）
- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md（confirmation、`tools.core` 白名单 / `tools.exclude` 黑名单优先、`inactivityTimeout`）

**gpt-engineer**
- https://github.com/AntonOsika/gpt-engineer/blob/main/README.md（improve 模式、`bench`、自荐改用 aider；pushed_at 2025-05-14）

**Devon**
- https://github.com/entropy-research/Devon/blob/main/README.md（四个功能 + 自述局限 + 停更）
- https://github.com/entropy-research/Devon/tree/main/devon_agent/tools/retrieval（`codebase_graph.py`）
- https://github.com/entropy-research/Devon/tree/main/devon_agent/tools/semantic_search（`code_graph_manager.py`、`graph_construction/languages/{python,typescript}`）

**AutoCodeRover**
- https://github.com/AutoCodeRoverSG/auto-code-rover/blob/main/README.md（46.20% Verified、24.89% full、30.67% lite、<$0.7/<7min、code search API、statistical fault localization、`selected_patch.json`）

**AutoGPT / MetaGPT**
- https://github.com/Significant-Gravitas/AutoGPT/blob/main/README.md（Platform 转型、`classic/` MIT、Classic/Forge/agbenchmark 入口）
- https://github.com/Significant-Gravitas/AutoGPT/blob/main/classic/README.md（`workspace/` 子目录沙箱、interactive approval 与授权范围、benchmark harness）
- https://github.com/FoundationAgents/MetaGPT/blob/main/README.md（`Code = SOP(Team)`、角色构成、DataInterpreter；pushed_at 2026-01-21）
