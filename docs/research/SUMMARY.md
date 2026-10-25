# 2026-10-26 AI 编程调研综合报告

综合四份同日笔记（官方文档 / 中文工程实践库 / GitHub 头部开源实现 / 商业产品），只回答一个问题：我们这条 issue → worktree → agent → 门禁 → 评审 → PR 的流水线，哪些环节有工业界依据、哪些是自己的发明、哪些被材料明确否定。

**结论摘要**

- 四路材料在「验证不能交给模型自评」上完全一致，且给的都是执行层手段（退出码 / 外部 harness / hook）——这一条我们已经做对（products.md:159、top-repos.md:181、vibe-coding-cn.md:59）。
- 唯一没有任何争议的红线：合并不交给 agent，四份材料无一例外（products.md:12、products.md:172、top-repos.md:60、deepseek-official.md:232）。
- 我们的超配项是「失败指纹回灌」与「机械评审规则集」，四份材料里找不到对应实现（products.md:179 只到注入上限）。
- 最大缺口是**验收裁决**：验收命令 exit 0 就继续，没有要求显式 PASS/FAIL 与证据（products.md:90、products.md:159）。
- 红线目前主要活在提示词和事后评审里，尚未成为执行层拦截（products.md:14、products.md:70、vibe-coding-cn.md:69）。

## 一、三路调研各自的硬结论

> 任务书标题写「三路」，实际是四份笔记四路来源；下面按文件分四节。

### 1.0 先给四路材料的可信度分层（不然后面引用会误读）

四种来源的证明力不一样，引用时不能混着用：

- **官方文档（deepseek-official.md）**：参数、限制、接口行为这类事实最硬，但它只说明「官方产品怎么设计」，不构成「工程上该怎么做」的建议；笔记本身也把推论与官方说法分开了（deepseek-official.md:5 的纪律声明、deepseek-official.md:83 标「笔者推论」）。
- **中文实践库（vibe-coding-cn.md）**：规则密度最高，但它是**单仓库的社区沉淀**，且自己标注社区经验部分是推文摘录、未经验证（vibe-coding-cn.md:195、vibe-coding-cn.md:198），没有真实失败案例库（vibe-coding-cn.md:261）。当规范书用可以，当证据用要打折。
- **开源实现（top-repos.md）**：只看代码行为，最接近「工业界实际怎么做」，但要注意 star ≠ 活跃度（top-repos.md:25），而且多数项目的 README 与实现有落差，笔记已经把 7 项标成未验证（top-repos.md:190）。
- **商业产品（products.md）**：覆盖面最广，但每条都带口径标注 `[一手]` / `[厂商自述]` / `[未验证]`，厂商自述部分只能当「设计意图」看，不能当「已实现」看（products.md:5 的标注规则、products.md:219 的缺口表）。

后面 §二 说「三源互证」，指的是**三种不同性质的来源同时指向同一结论**（开源实现 + 社区规范 + 商业产品，或再加官方旁证）；单一来源出现两次不算互证。

### 1.1 deepseek-official.md（DeepSeek 官方口径）

- 现行只有两个 API 模型名：`deepseek-flash`（=V4.1-Flash-1017）与 `deepseek-v4-pro`；上下文 1M、输出上限 384K（deepseek-official.md:13、deepseek-official.md:53）。
- 编程强度建议三段演进：2026-04「复杂 Agent 场景用思考模式 + max」→ 2026-08「简单 low / 日常 Agent high / 高难 max」；Claude Code 接入指引直给 max（deepseek-official.md:94、deepseek-official.md:96）。
- 思考模式下 `reasoning_content` 是硬约束：只要请求带 tools，后续所有请求必须完整回传历史思考链，否则 400（deepseek-official.md:140、deepseek-official.md:189）。
- 思考模式里 `temperature` / `presence_penalty` / `frequency_penalty` 设置不报错也不生效；`top_p` 被限到 0.95–1.0 或被忽略（deepseek-official.md:104、deepseek-official.md:188）。
- 接口层硬限制：FIM 补全最大 4K 且仅非思考模式；Chat Completion 不支持在历史中间插入 tool 消息，长链 Agent 要换 Anthropic 或 Responses API（deepseek-official.md:62、deepseek-official.md:155）。
- `/chat/completions` 无状态，多轮历史完全由客户端拼接；前缀缓存尽力而为、不保证命中，久不用会清空（deepseek-official.md:136、deepseek-official.md:65）。
- DSH 侧压缩只能处理 pressure / context-overflow 两类触发，官方明确「单个超大保留单元无法靠 surface 压缩修复」（deepseek-official.md:145、deepseek-official.md:192）。
- 官方自己的自动化流水线示例（PR 就绪后自动评审）刻意选 read-only，并禁止改文件、分支、PR；三处关键「未找到」也照实记录了：长文件截断、必须分步执行、多文件自动改写准入条件（deepseek-official.md:236、deepseek-official.md:216、deepseek-official.md:239）。

### 1.2 vibe-coding-cn.md（中文工程实践库）

- 最核心一条是原文级原则：AI 不能自证正确；凡是能被测试、类型、schema、lint、CI 校验的规则，都应变成机器门禁，而不是只写在提示词里（vibe-coding-cn.md:59）。
- 八条铁律里最能落地的三句：「不把看起来对当成完成」「只相信可复现命令、测试输出、CI 状态和可审查 diff」「不符合规范的产出必须失败，而不是靠人记住提醒 AI」（vibe-coding-cn.md:65、vibe-coding-cn.md:68、vibe-coding-cn.md:70）。
- 机器门禁的四项职责写得很具体：拦幻觉（依赖/路径/命令/链接不存在直接失败）、拦糊弄（无测试无验收证据不许合并）、拦越界（不符 AGENTS/schema/目录规范直接报错）、强制分发（vibe-coding-cn.md:72）。
- 验收纪律：未检查项保留「未验证」不算通过；命令启动、脚本退出码、页面可见**单独都不等于**目标完成；上次验收后改了代码，旧证据只适用于当时版本（vibe-coding-cn.md:79、vibe-coding-cn.md:82、vibe-coding-cn.md:83）；同一篇还要求不能用被测实现的输出倒推正确答案，新会话复核能发现遗漏但不能冒充独立人工审查（vibe-coding-cn.md:80、vibe-coding-cn.md:84）。
- 安全与 Git 纪律：AI CLI 不是安全沙箱；不执行 reset/clean/stash/强推/强制切换；不用 `--no-verify` 绕过 hooks；「本地总测试不等于远端 CI」（vibe-coding-cn.md:91、vibe-coding-cn.md:103、vibe-coding-cn.md:104、vibe-coding-cn.md:106）。
- 与我们直接相关的坑：代码文件太大超上下文、系统提示词太长被忽略、多轮对话上下文污染、AI 生成的测试只覆盖 happy path、API Key 提交进 Git（vibe-coding-cn.md:120、vibe-coding-cn.md:125、vibe-coding-cn.md:128、vibe-coding-cn.md:130）。
- 性能段是一条负向清单：没有 profiling 定位瓶颈、没有 benchmark baseline、没有 correctness regression 就声称性能提升，一律禁止；总原则见同篇（vibe-coding-cn.md:153、vibe-coding-cn.md:160）。
- 未找到：该仓库**没有**集中式的真实项目失败复盘 / 事故案例库，坑表是「问题-原因-解决方案」形式（vibe-coding-cn.md:261）。

### 1.3 top-repos.md（开源实现横向）

- 十条可执行工程动作里与我们最贴的是三条：上下文用 repo map + token 预算（默认 1k）、验证交给退出码、评测外部化交 harness 打分（top-repos.md:15、top-repos.md:17、top-repos.md:24）。
- Aider 的验证契约最省事：`--lint-cmd` / `--test-cmd` / `--auto-test` 全部靠**非零退出码**驱动下一轮修复；安全网是每次改动自动 commit（top-repos.md:58、top-repos.md:60）。
- SWE-agent 的 ACI 四条：编辑即 lint、viewer 每轮只给 100 行、搜索只列命中文件、空输出显式回话；连续 2 次格式错即终止 episode（top-repos.md:79、top-repos.md:84）。
- 审批做成可编程钩子是成熟形态：Claude Code 的 `PreToolUse` / `PostToolUse` 等事件里，exit code 2 = 阻断该动作（top-repos.md:20、top-repos.md:118）。
- Codex 把每个动作类别做成独立 approval 请求（exec / apply-patch / file-change / permissions），沙箱按平台分实现（top-repos.md:125、top-repos.md:126）。
- 回滚与 git 解耦：Gemini 的 `/restore` 同时恢复文件与会话历史，Roo Code 用独立 shadow 仓在改文件前快照（top-repos.md:132、top-repos.md:111）。
- 选型事实比 star 更该先看：Roo Code 2026-05-15 停服、Continue 只读、gpt-engineer 2025-05-14 停更；`anthropics/claude-code` 仓库不含产品源码（top-repos.md:25、top-repos.md:26）。
- 「防假成功」的三条共识做法：让进程退出码说话、让外部 harness 说话、让语法/静态检查在落盘前说话；模型说「我修好了」在这三个项目里都不是判据（top-repos.md:181、top-repos.md:184、top-repos.md:186）。

### 1.4 products.md（商业产品方案）

- 没有一家把「合并」交给 agent。第一梯队全部停在「agent 建分支 → commit → push → 开 PR」，评审结论与 merge 按钮留在人手里（products.md:12）。
- 「完全自动化」的真实工业形态是「事件触发 + 沙箱 + 事后评审」，不是无人值守：触发条件、任务边界、红线全部由人预先写成文件（products.md:13）。
- 本轮最有价值的一条：红线不是提示词，是执行层。写在 CLAUDE.md 里的禁令只是「请求」，`PreToolUse` hook 拦截才是「执行」，且权限规则由工具而非模型强制（products.md:14、products.md:70）。
- 任务边界的载体收敛成三层：仓库级约定文件、环境定义文件、计划与规格产物——没有一家靠「对话里说清楚」（products.md:15）。
- 计划必须物化成人可编辑、可批准、可提交的仓库产物（Junie 的 `.junie/plans` 四页签，Comate 的 Spec 模式）（products.md:30、products.md:158）。
- 验证要显式裁决：agent 进程跑完不代表检查通过，必须输出 PASS/FAIL，非 PASS 一律算失败（products.md:90、products.md:159）。
- 记忆都有硬上限：CLAUDE.md 建议 <200 行、auto memory 每会话 200 行 / 25KB、Devin 注入 AGENTS.md 只取前 16 KiB（products.md:63、products.md:69、products.md:81、products.md:179）。
- 国内产品普遍停在「IDE 内自主编码」，权限模式 / 评审归属 / 合入策略基本未公开；CodeGeeX 连自主 agent 都未宣称（products.md:16、products.md:17、products.md:225）。

### 1.5 剩下的事实性硬参（不构成结论，供 §三/§四/§六 引用）

上面四节只收「能当结论用」的条目，每源封顶 8 条。下面这些是有原文依据、但属于参数/单点事实，写在这里备查，免得正文塞不下就丢掉：

- 成本结构上有一条对 Agent 特别重要的判断：官方明确「Agent 使用场景中，缓存命中的费用往往占比较高」，且峰谷价差一倍、缓存命中与未命中差 50 倍量级（deepseek-official.md:67、deepseek-official.md:78、deepseek-official.md:83）。
- 计费变更已在日程上：Search / Fetch 经 Server 端工具调用目前暂未计费，但**2026-11-01 00:00 起按次收费**，5 元 / 千次成功请求（deepseek-official.md:80）。
- strict 模式（Beta，需 `/beta` base_url）有一组容易踩的缺口：所有属性必须 required 且 `additionalProperties:false`，**不支持** `minLength`/`maxLength`/`minItems`/`maxItems`（deepseek-official.md:166）。
- 六步法里第 4 步是「用证据验收」并列了四项验收表，第 6 步把 git 检查点明确标为**可选项**而不是强制（vibe-coding-cn.md:217、vibe-coding-cn.md:219）。
- 门禁的落地形态是 `make` 目标清单 + RED→GREEN 循环；不删测试、不削弱断言是硬规则（vibe-coding-cn.md:234、vibe-coding-cn.md:235）。
- Skill 层 8 条反模式里最有价值的一句是「错的指引比没有指引更糟」——写进提示词/规则文件的约束如果过时或在撒谎，比不写更坏（vibe-coding-cn.md:182、vibe-coding-cn.md:189）。
- 节奏建议是「10 分开发，7 分查资料」，与官方「先摸清仓库结构与包边界」同向（vibe-coding-cn.md:204、deepseek-official.md:131）。
- 计划层已有「双模型分工」的现成解法：Aider 的 architect 出方案、editor 落补丁，两者可以是不同模型（top-repos.md:57）。
- 沙箱有三种成熟跑法：OpenHands 支持无沙箱 / 单 Docker / 多 Docker，配 `SecurityAnalyzerBase` 三档分析器与三种确认策略，风险级分 LOW/MEDIUM/HIGH/UNKNOWN（top-repos.md:68、top-repos.md:69、top-repos.md:72）。
- 横向对照表的答案是「没有任何项目在全部七个维度上都最强」：计划看 Cline/Codex、验证看 Aider、上下文看 OpenHands、审批看 Codex、回滚看 Gemini/Roo（top-repos.md:170、top-repos.md:179）。抄的时候只能按维度挑。
- 分歧样本：华为 CodeArts 把质量保障放在**平台流程**（MR 工作流隐含人工合入）而不是 agent 权限（products.md:124）——与「红线做成 hook」是两条路线，前者管流程、后者管动作。
- Devin 的经验法则是「任务超过三小时说明边界没切好」（products.md:80）；Junie 把显式裁决做成产品功能，`/demo` 直接出 PASS/FAIL，并自带 1500+ PR 与 22 场景冒烟数据（products.md:90）。
- M1–M15 是全文最可直接抄的一节：权限三层、hook 才是红线、注入按字节裁、计划物化、验证显式裁决、低置信降级、评审者复用工程上下文、ephemeral 环境 + 分支归 agent / 合入归人、快照与 git 解耦（products.md:150、products.md:164）。本报告的 P0/P1 基本按这一节挑选。

## 二、四路交叉验证：一致 / 冲突 / 空白

### 2.1 三源互证的一致点

1. **验证必须由程序裁决，不能由模型自评**——开源实现（top-repos.md:17、top-repos.md:181）、中文实践库（vibe-coding-cn.md:59、vibe-coding-cn.md:72）、商业产品（products.md:159）三源互证；官方侧也有旁证：其自动化示例只给只读权限（deepseek-official.md:236）。
2. **红线必须代码化**——vibe-coding-cn.md:69 要求能写成 lint/test/hook/CI 的规范不要只写提示词；products.md:14 的原文口径是「hook 才是执行」；top-repos.md:20 给出 hook exit code 2 的可阻断实现。三源互证，且都指向同一实现形态：执行层拦截。
3. **合入与「能不能上线」留给人**——products.md:12、products.md:172 是产品面；top-repos.md:60（Aider 只到自动 commit）；deepseek-official.md:232（官方产品默认「需要审批就问你」）。三源互证。
4. **边界载体是文件，不是对话**——products.md:15 归纳出三层载体；vibe-coding-cn.md:67 要求 README/AGENTS/任务文档持续更新；top-repos.md:96（`.clinerules`）；deepseek-official.md:131（官方推荐先摸清仓库结构与包边界）。三源互证。
5. **上下文与记忆必须有硬上限**——products.md:179（无界记忆写入被列为「不自动化」项）、deepseek-official.md:145（DSH 明说单个超大单元不可压缩）、vibe-coding-cn.md:120（文件太大模型处理不了）、top-repos.md:15（repo map 只给 1k 预算）。三源互证。
6. **重试必须有硬预算**——top-repos.md:84（连续 2 次格式错终止）、vibe-coding-cn.md:85（失败或中断先核对实际状态，不要自动重跑有副作用的操作）、products.md:174（模糊任务会跑偏，所以要设边界）。三源同向。
7. **沙箱与审批必须分层，不是单一开关**——top-repos.md:69（同一套动作分 `AlwaysConfirm`/`NeverConfirm`/`ConfirmRisky` 三档，再叠风险级）、products.md:150（权限三层 deny>ask>allow，先命中者胜）、deepseek-official.md:234（官方两档预设：`workspace-write`+ask 与 `danger-full-access`+never）。三源互证「分层」这个形态。
8. **证据要落到可审查的外部载体，而不是只活在对话里**——top-repos.md:24（评测结果写 `preds.json` / `selected_patch.json` 交 harness 打分）、products.md:159（显式 PASS/FAIL 裁决）、vibe-coding-cn.md:217（四项验收表）。三源互证。

### 2.2 冲突点（各自原文口径差异）

1. **「自动化到什么程度」三种口径并存。** 官方产品默认人工审批、自动化示例给只读（deepseek-official.md:232、deepseek-official.md:236）；vibe-coding-cn 要求「不符合规范的产出必须失败」（vibe-coding-cn.md:70），语气指向全自动门禁；products.md:182 又明确说不该删人工卡点，而要给不可逆动作造可回滚替代物。三者口径差异在于**对象不同**：官方讲的是产品默认策略，vibe 讲的是门禁可以自动、products 讲的是交付不能自动。可以同时成立：门禁全自动、交付不自动。
2. **稳定性该调温度还是调档位。** 官方现状是思考模式下 temperature 不生效（deepseek-official.md:104），且自己注明 R1 时代的「temperature 0.5–0.7」不能套到 V4.1（deepseek-official.md:127）；但 vibe-coding-cn.md:125 的坑表仍把「温度参数」当作可调项。差异来自世代不同，不能混用。
3. **重试终止阈值没有统一口径。** top-repos.md:84 是「连续 2 次格式错就终止 episode」；Aider 走的是「改 → 跑 → 修」的循环，没有看到硬终止（top-repos.md:58）。两者都没给出「同一根因」的判定方法，我们的 3 次 + 指纹属于自己发明。
4. **冲突自动解决：这是唯一一处我们的做法被材料明确否定。** vibe-coding-cn.md:101 要求 `git status --short` 出现未合并/冲突路径时**先暂停**，不要自动解冲突、不要自动中止合并或变基；我们现在的做法是自动 rebase，基线文件自动 `--bless` 重算、源码冲突交给 agent 解（`ci/dispatch.mjs:780` 的 `rebaseAgentBranch`）。products.md 与 top-repos.md 都没有支持「自动解源码冲突」的证据，top-repos.md:132 只讲到改前快照与回滚。这条要单独立项处理。
5. **「改动越小越好」的阈值。** top-repos.md:179 把成本标定到「单任务 <$0.7 / <7 分钟」这种量级；vibe 侧只说「不吞掉异常、不打局部补丁」（vibe-coding-cn.md:175），没有量化。我们的 `diff-large` 400 行 warn（`ci/review.mjs:118`）在四份材料里找不到可对标阈值。
6. **上下文压缩是「管线」还是「兜底」。** OpenHands 把压缩做成可插拔管线，有 `RollingCondenser` / `LLMSummarizingCondenser` / `PipelineCondenser` 三种策略和 `max_size` 阈值（top-repos.md:22）；DSH 侧只有 pressure / context-overflow 两种触发，且单单元不可修复（deepseek-official.md:145）。前者是「主动按预算裁」，后者是「撞墙了才压」——两种哲学，对长任务的表现会不一样，但没有任何材料做过对照。

### 2.3 空白（没人说清的问题）

1. **多文件自动改写的准入条件、批处理策略、风险清单**——官方明确「未找到」（deepseek-official.md:239、deepseek-official.md:241），国内产品也没有公开定义（products.md:225）。这块是真空。
2. **哪些冲突可以自动解、哪些必须暂停**——没有任何材料给出判据；vibe 只有「先暂停」这一条否定式要求（vibe-coding-cn.md:101），products 只谈 PR 归属不谈冲突。
3. **语义评审（模型审模型）的可信度**——products.md:161 只说到「评审规则读仓库文件、复用同一套构建/测试」，没有一家给出评审误判率、人工抽检比例或升级路径。我们的 `ci/semantic-review.mjs` 属于无参照自建。
4. **失败知识的容量与淘汰**——products.md:179 只给「注入上限」，不给「存储上限 + 过期策略」；vibe 明确没有失败库（vibe-coding-cn.md:261）。我们 `docs/failures.jsonl` 的淘汰策略在材料里找不到依据。
5. **谁能改门禁脚本**——最接近的是 products.md:177（受保护路径单独控制）与 products.md:26（企业侧显式启用能力），但都没有给出「授权必须落到哪个可执行判定」的规则。我们的 `allow:gate` label 是自己发明的。
6. **无人值守时单任务的时间/成本上限**——只有 AutoCodeRover 自报「每任务 <$0.7、<7 分钟」（top-repos.md:154），没有材料讨论「没人盯着时一个任务最多该跑多久」。
7. **语义评审 block 之后的仲裁路径**——产品都提供人工介入，但没人说清「评审 block 与 agent 自认为完成」冲突时谁让步；我们的现行做法是 block 即死（`ci/semantic-review.mjs:101`），人力只能靠重开工单，这条路在材料里没有参照。
8. **规则文件的过期与版本**——vibe 自己说了错的指引比没有更坏（vibe-coding-cn.md:189），但没有材料给出「规则多久复核一次、谁负责失效」的机制；我们的 `AGENTS.md` 与提示词模板目前没有任何过期标记。

### 2.4 如果只能抄三条

四路材料加起来两百多条事实，压到我们的处境上只值得抄三条，其余都要先看是否与已有实现重复：

1. **验证交程序、证据落文件**——把「agent 说做完了」替换成「一条可复现的命令 + 一份结构化的 PASS/FAIL 产物」（products.md:159、top-repos.md:17）。我们现在有前者，缺后者。
2. **红线进执行层**——同一条规则，写在提示词里是「请求」，写在 hook / 校验脚本里才是「执行」（products.md:14、products.md:70、top-repos.md:20）。我们 4 条不自动化里还有 1 条停在提示词。
3. **合入与发版永不给 agent**——四份材料零反例（products.md:12、products.md:172、top-repos.md:60、deepseek-official.md:232）。这条不是「暂时不做」，而是长期免责声明，要写进 PR 模板里让每个评审的人都看见。

## 三、对照我们的自动化流水线

判定口径：**已有** = 与材料推荐做法同向且有执行层实现；**部分有** = 方向对但缺关键一环；**缺失** = 材料明确要求而我们没有。

### 3.1 触发与隔离

- **轮询 GitHub Issues 的 `agent:ready` label**（`ci/dispatch.mjs:577` 的 `pollOnce`）——判定：**已有**。依据：products.md:13（事件触发是工业界真实形态）。
- **git worktree 隔离（`D:/code/.worktrees/issue-N`）**（`ci/dispatch.mjs:233` 的 `setupWorktree`）——判定：**已有**。依据：products.md:163（ephemeral 环境 + 分支归 agent）。缺口：没有「改前快照」（top-repos.md:132）。
- **headless agent（`--profile headless`，`ci/headless-task.sh`）**——判定：**部分有**。依据：products.md:163 说工业界的上限位置是「agent 拿分支写权限、人拿合并权限」，我们比这更进一步（agent 连 commit 都不许做，调度器代做）。但 agent 侧的 permission preset 四份笔记都没覆盖（见 §六）。
- **模型路由 `-p patch`：默认 XingChenAGI/Xing4.0-29B，重试升级 DeepSeek-V4.1-Flash**——判定：**部分有**。依据：deepseek-official.md:94 官方给的是按任务复杂度分档（low/high/max），我们分的是「便宜 / 贵」两档，没有 effort 旋钮；deepseek-official.md:249 明确说稳定性应靠固定档位而不是温度。
- **单实例锁 + 心跳 + 7 天日志轮转**（`ci/dispatch.mjs:175` 的 `acquireLock`、`:91` 的 `pruneLogs`）——判定：**已有（无调研依据）**。四份材料都没讨论调度器自身的高可用，这部分完全是我们自建。
- **常驻 `--serve` + `--ensure` + HKCU Run 登录自启 + 计划任务每 5 分钟 `--once` 兜底**（`ci/dispatch.mjs:937` 的 `startResident`、`:949` 的 `main`）——判定：**已有（无调研依据）**。四份材料都只谈 agent 侧，不谈调度器自身存活；这层只有日志没有单测，属于已知的验证盲区（见 §6.4）。

### 3.2 验证层

- **调度器自己跑 `bash scripts/verify.sh`，不采信 agent 自述**（`ci/dispatch.mjs:316` 的 `verifyWorktree`）——判定：**已有**，且是四源共同推荐的核心做法。依据：top-repos.md:17、top-repos.md:181。
- **执行 issue 里的 `### 验收命令`，exit 全 0 才继续**（`ci/dispatch.mjs:453`–`:463`）——判定：**部分有**。依据：products.md:90 与 products.md:159 都要求显式裁决；我们现在是「退出码绿就算过」，没有要求 agent 写出 PASS/FAIL 与证据，也没有把输出留档。
- **没有 `### 验收命令` 的工单只记日志、不阻断**（PR body 文案见 `ci/dispatch.mjs:524`）——判定：**缺失**。依据：vibe-coding-cn.md:82（命令启动、退出码单独都不等于完成）；products.md:174（vague 任务会跑偏）。
- **`scripts/verify.sh` 的测试数 + 断言数基线不得下降**（`scripts/test-baseline.txt`）——判定：**已有**，属执行层红线。依据：vibe-coding-cn.md:69、vibe-coding-cn.md:72。注：文件现值是 `92 194`，与任务书写的 92 193 差 1（见 §六）。
- **断言内容 sha256 指纹基线**（`scripts/assert-baseline.txt` + `scripts/assert-guard.mjs`，verify.sh 的 `== assert guard ==` 段）——判定：**已有且超配**。依据：vibe-coding-cn.md:70（不符合规范的产出必须失败）；四份材料里没有看到同等的「改断言也不行」机制。
- **CI 两个 step：verify + 跨分支基线对比**（`.github/workflows/ci.yml`）——判定：**已有**。依据：vibe-coding-cn.md:106（本地总测试不等于远端 CI）。

### 3.3 评审层

- **机械评审 `ci/review.mjs`（forbidden-path / debug-residue / test-removed / assert-removed / baseline-unsynced / dependency-added / gate-modified / no-file-change）**（`reviewDiff`，`ci/review.mjs:49`）——判定：**已有**，且恰好覆盖 vibe 说的三类拦截：`no-file-change` 拦「空提交糊弄」，`gate-modified` 拦「改门禁放宽标准」，`dependency-added` 拦越界（vibe-coding-cn.md:72）。
- **语义评审 `ci/semantic-review.mjs`（Qwen3.5-122B，读 diff + 文件清单 + 已跑验收命令，输出 pass/block JSON，block 或不可解析即中止）**（`parseVerdict`，`ci/semantic-review.mjs:101`）——判定：**已有**，且严格性口径正确：非法 JSON、缺 verdict、`verdict=pass` 却带 block finding，三种情况都归到失败（同文件 `:126`–`:131`）。依据：products.md:159（非 PASS 一律算失败）。
- **语义评审不要求 agent 提供运行证据（日志 / 截图 / 输出尾部）**（`buildReviewPrompt`，`ci/semantic-review.mjs:60`）——判定：**缺失**。依据：products.md:159（M10：验证要显式裁决，不接受「进程正常退出」）。
- **评审规则硬编码在代码里，不读仓库内的规则文件**（同上）——判定：**部分有**。依据：products.md:161（评审规则应读 `BUGBOT.md` 一类的仓库文件，评审者与被评审者共享上下文）。我们的规则改一次要改代码、要 `allow:gate`。

### 3.4 交付与失败处理

- **commit → push 分支 → 开 PR（body 写自动检查摘要）→ label `agent:done`**（`ci/dispatch.mjs:517`–`:530`）——判定：**已有**。依据：products.md:163、products.md:12（这是工业界的自动化上限位置）。
- **PR body 里没有「需要人工确认」的固定段**（同上区间）——判定：**缺失**。依据：products.md:172（评审与上线判断必须留给人，且要显式声明）。
- **失败重试最多 3 次 + 回灌失败原因**（`ci/dispatch.mjs:336` 的 `runTask`）——判定：**已有**。依据：top-repos.md:23、top-repos.md:84（重试要有硬预算）。缺口：没有「同签名连续 2 次即短路」的终止条件（top-repos.md:84）。
- **失败指纹化（`normalize` / `signature` / `fingerprint`）+ `docs/failures.jsonl` + prompt 注入「历史同类失败」**（`ci/failures.mjs:24`、`:45`、`:65`、`formatPriorFailures` `:121`）——判定：**已有且超配**，四份材料里没有对应实现。缺口：store 无上限、无淘汰（products.md:179 只给了注入上限；vibe 侧根本没有失败库，vibe-coding-cn.md:261）。
- **CI 失败回环 `repairCI`（拉失败 job 日志回灌 agent 修，最多 3 次）**（`ci/dispatch.mjs:622`）——判定：**部分有**，是材料里唯一有对应物的机制（vibe-coding-cn.md:106「本地总测试不等于远端 CI」要求必须有远端回路）。缺口：失败日志是截断后整段回灌，没有按同根因合并。
- **冲突自动 rebase（基线文件自动 `--bless` 重算，源码冲突交 agent，最多 5 次）**（`ci/rebase-conflict.mjs:10` 的 `classifyConflicts`、`ci/dispatch.mjs:716` / `:742` / `:780`）——判定：**部分有，且方向与材料相反**。依据：vibe-coding-cn.md:101 明确要求冲突路径出现时先暂停、不要自动解冲突；top-repos.md:132 只支持「改前快照 + 回滚」。
- **`readonly:ok` 工单只报结论不开 PR**——判定：**已有**。依据：deepseek-official.md:236（官方自动化示例只读）、products.md:175（低置信动作降级为建议）。
- **`allow:gate` 才允许改门禁脚本**（`ci/review.mjs:105`）——判定：**部分有**。依据：products.md:177（受保护路径单独控制）。缺口：放行后只降级为 warn、没有任何「谁批的、批了什么」的记录，等于一半回到了人的记忆。

### 3.5 明确不自动化的部分（与材料对照）

- **不自动 merge**——判定：**已有且与四源一致**。依据：products.md:172、top-repos.md:60、deepseek-official.md:232。
- **不自动发版**——判定：**已有**。依据：products.md:178（发布/部署是以显式配置步骤存在，不由 agent 自主决定）。
- **不加依赖**（`dependency-added` block）——判定：**已有**。依据：products.md:177 的相近口径 + AGENTS.md 契约。
- **不改 workflows**——判定：**部分有**。现在靠 buildPrompt 的提示词（`ci/dispatch.mjs:290` 一带）+ `forbidden-path` 事后拦截；材料要求的是执行层拦截在前（products.md:14、top-repos.md:20）。

### 3.6 判定汇总（28 项）

- 统计：**已有 15 项 / 已有但无调研依据 2 项 / 部分有 8 项 / 缺失 3 项。**
- 3 项缺失全部集中在「验收裁决」与「人类归属的显式声明」两处，正好对应四份材料里最硬的两条结论（products.md:159、products.md:172），所以 P0 的前两条与第 5 条都落在这里。
- 8 项「部分有」里有 5 项缺的是同一个东西：**缺产物**——验收缺裁决文件、评审缺证据、放行缺记录、CI 回灌缺归并、冲突缺暂停点。这解释了为什么 P0-1 与 P1-6 都要求「落一个文件」，而不是「多写一段提示词」。
- 我们能拿出去讲的两项（失败指纹回灌、断言内容指纹基线）在四份材料里都找不到同等实现，属于超出调研范围的自建能力；代价是没有外部参照口径，评审标准只能自己定。

## 四、改进 backlog

### P0（当夜可落地，6 条）

**P0-1 验收的显式裁决：exit 0 不再等于通过**

- 做什么：验收命令跑完后，要求产出结构化裁决（命令、退出码、输出尾部、`verdict: PASS|FAIL`）；只有 PASS 才继续，缺失或非法一律当失败并写进失败回灌。
- 落在：新增 `ci/verdict.mjs`（复用 `ci/semantic-review.mjs:101` `parseVerdict` 的严格口径），在 `ci/dispatch.mjs:runTask` 的 `acceptanceCmds` 分支（现 `:453`–`:463`）调用。
- 依据：products.md:90、products.md:159（非 PASS 一律算失败）；vibe-coding-cn.md:82。
- 怎么验收：新增 `ci/verdict.test.mjs` 覆盖三种用例（退出码 0 但无裁决 / 非法 JSON / 退出码 0 却 FAIL），全部判失败；`scripts/verify.sh --bless` 更新基线。

**P0-2 红线做成执行层：worktree 内置 pre-commit hook**

- 做什么：进 worktree 时装 `core.hooksPath=.githooks`，用 pre-commit 把「改 `.github/workflows/*`、改 `scripts/verify.sh` 门禁段、删测试/断言、暂存凭据」变成非零退出的硬拦截；提示词里的第 4 条保留，但不再是唯一防线。
- 落在：新增 `.githooks/pre-commit`（复用 `ci/review.mjs:139` 的 `reviewWorktree`），由 `ci/dispatch.mjs:233` 的 `setupWorktree` 安装。
- 依据：products.md:14、products.md:70（hook 才是执行）；vibe-coding-cn.md:69、vibe-coding-cn.md:104（不许用 `--no-verify` 绕过）。
- 怎么验收：在任一 worktree 手改 workflows 后 `git commit` 必须被拒；再试 `git commit --no-verify`，确认 push 前 `reviewDiff` 的 `gate-modified` 仍能拦住。

**P0-3 规则/计划物化进仓库：issue 章节落成 PLAN.md**

- 做什么：把 issue 的 `### 目标` / `### 验收标准` / `### 约束` 在 worktree 里写成 `PLAN.md` 并随 PR 提交；语义评审把该文件当评审对象之一，机械评审加一条「无 PLAN.md」规则（先 warn 观察）。
- 落在：`ci/dispatch.mjs:263` 的 `buildPrompt`（加写 `PLAN.md` 的指令）+ `ci/semantic-review.mjs:60` 的 `buildReviewPrompt`（读入该文件）。
- 依据：products.md:15、products.md:158（计划要是可评审工件）；vibe-coding-cn.md:67。
- 怎么验收：开一单，PR diff 必含 `PLAN.md`；`ci/review.test.mjs` 加「缺 PLAN.md → warn」用例。

**P0-4 记忆容量上限：`failures.jsonl` 加硬上限与淘汰**

- 做什么：给失败库定条数上限与单行长度上限，超出按 FIFO 淘汰；`lookup` / `formatPriorFailures` 只在最近窗口内命中。
- 落在：`ci/failures.mjs:104` 的 `recordFailure` + `ci/failures.mjs:140` 的 `repairStore`。
- 依据：products.md:179（无界记忆写入被明确列为不自动化项）、products.md:155（上限 + 分层才是记忆的工程解）。
- 怎么验收：`ci/failures.test.mjs` 加「连续写入超过上限后行数 = 上限，且最新一条仍能 `lookup` 命中」。

**P0-5 评审与合并的人类归属：PR body 固定确认清单**

- 做什么：PR body 增加固定段「需要人工确认」四类（合并 / 发版 / 依赖变更 / 门禁变更），并写明 `agent:done` 的含义是「可评审，未合并」；同时确认代码里不存在任何 merge 调用。
- 落在：`ci/dispatch.mjs` PR body 构造处（现 `:517`–`:530`）。
- 依据：products.md:12、products.md:172（没有一家把 merge 交给 agent）。
- 怎么验收：随便开一个 PR，body 必含该段；`grep -n 'merge' ci/dispatch.mjs` 只剩注释与 rebase 相关，没有合并写操作。

**P0-6 没有 `### 验收命令` 的工单不再进交付流程**

- 做什么：解析不到验收命令时，不再照常跑完去开 PR，而是降级成只读结论模式（同 `readonly:ok` 处理）或直接 `failTask`，comment 指明缺哪一节。
- 落在：`ci/dispatch.mjs:runTask` 的验收命令解析处（现 `:451`–`:463`），配套改 `:524` 的 PR body 文案。
- 依据：vibe-coding-cn.md:82（退出码/命令启动单独不等于完成）；products.md:174（口径含糊的任务会跑偏，应先定义再动手）。
- 怎么验收：造一个只有「验收标准」没有「验收命令」的 issue，期望走 `failTask`（`ci/dispatch.mjs:299`）并在 issue 上留言说明缺哪节。

### P0 执行顺序与共同风险

- 建议顺序：P0-2（hook）→ P0-6（验收命令缺失降级）→ P0-1（裁决文件）→ P0-4（记忆上限）→ P0-5（人类确认段）→ P0-3（PLAN.md）。先做「拦得住的」，再做「要新产物的」；P0-3 会改变所有工单的 PR 形状，放最后以免干扰前五条的观察窗口。
- 共同风险一：**动了基线就要 bless。** 除 P0-5 外每条都要加测试，按项目契约必须同 PR 跑 `bash scripts/verify.sh --bless` 并说明原因，否则测试数基线与跨分支断言对比两个 step 会直接拒（依据：项目 AGENTS.md 契约、vibe-coding-cn.md:235）。
- 共同风险二：**P0-1 会让在途工单立刻失败。** 裁决文件是新的必需产物，已在跑的分支没有它；上线时要么只对新工单生效，要么先允许「无裁决 → warn」观察一周再转 block。
- 共同风险三：**hook 能被 `--no-verify` 绕过**，所以 P0-2 必须与 push 前的 `reviewDiff` 双重覆盖；单靠 hook 等于把门锁换成帘子（vibe-coding-cn.md:104）。
- 共同限制：**不要为此动 `.github/workflows/*`。** 六条 P0 全都能在 `ci/` + `scripts/` + `.githooks/` 内完成；任何一条需要改 CI 定义，说明方案选错了。

### P1（一周内）

- **冲突自动解决边界收紧**：源码冲突默认不再自动解，只保留基线文件 `--bless` 自动重算，其余暂停等人 → 落 `ci/dispatch.mjs:742` 的 `resolveConflictsWithAgent` → 依据 vibe-coding-cn.md:101 → 验收：`ci/rebase-conflict.test.mjs` 加「非基线文件不进 agent 通道」用例。
- **重试短路**：同签名连续 2 次失败即终止并升级，不再跑满 3 次 → 落 `ci/dispatch.mjs:336` 的 attempt 循环 + `ci/failures.mjs:45` 的 `signature` → 依据 top-repos.md:84 → 验收：`failures.test.mjs` 加短路用例。
- **上下文档位**：注入 AGENTS.md 时按字节裁并显式提示截断 → 落 `ci/dispatch.mjs:263` 的 `buildPrompt` → 依据 products.md:81（16 KiB 上限）、deepseek-official.md:145（超大单元不可压缩）→ 验收：超长 AGENTS.md 时 prompt 里出现截断提示。
- **评审规则外置**：把 `buildReviewPrompt` 的判定口径搬到仓库文件，让语义评审规则与机械规则同源可审 → 落 `ci/semantic-review.mjs:60` → 依据 products.md:161 → 验收：单测断言「改规则文件后 prompt 内容随之变化」。
- **差异分级**：`diff-large`（现 >400 行 warn，`ci/review.mjs:118`）改成两级（>400 warn / >800 block，除非 `allow:large`），呼应「一 PR 一切片」 → 依据 top-repos.md:179（成本标定）+ 项目 AGENTS.md 契约 → 验收：`review.test.mjs` 覆盖两个阈值。
- **成功路径也留审计**：每次 attempt 落一条 jsonl（issue / attempt / 耗时 / 裁决），只写仓库 `docs/`，不写外部服务 → 落 `ci/dispatch.mjs:76` 的 `log` 附近 → 依据 vibe-coding-cn.md:83（旧证据只适用于当时版本，必须可追溯）→ 验收：跑一单后 jsonl 多一行且字段齐全。

### P2（一月内）

- **规则文件分层加载**（仓库 / 子目录 / 路径作用域，按需注入而不是整篇塞）→ 落 `ci/dispatch.mjs:263` 的 `buildPrompt` → 依据 products.md:154 → 验收：单测断言子目录规则只在命中路径时出现。
- **子上下文隔离只回摘要**：给 `repairCI`（`ci/dispatch.mjs:622`）的修复 agent 单独上下文，主流程只收摘要 → 依据 products.md:157 → 验收：主 prompt 长度不再随 CI 日志增长。
- **改前影子快照**：`setupWorktree` 里在 agent 首次改动前做一次与 git 解耦的快照，便于失败回滚 → 落 `ci/dispatch.mjs:233` → 依据 top-repos.md:132、products.md:164 → 验收：故意让 agent 破坏工作树后能一键还原到快照。
- **计划模板四页签**（需求 / 技术设计 / 交付阶段 / 测试策略）补进 `PLAN.md` 生成指令 → 落 `ci/dispatch.mjs:263` → 依据 products.md:158、products.md:30 → 验收：新 PR 的 `PLAN.md` 四个小节都不为空或显式写「不适用」。
- **成本标定**：参考「每任务 <$0.7 / <7 分钟」的量纲，给每次 attempt 记 token 与墙钟时间 → 落 `ci/dispatch.mjs:336` 的 `runTask` → 依据 top-repos.md:154 → 验收：审计 jsonl 出现 token 与耗时字段，能按周汇总。

## 五、明确不自动化清单

以下内容依据四份笔记的**否定证据**，我们不自动化，且不因为「想再往前一步」而删掉卡点（products.md:182）。

1. **合并（merge）与「这改动能不能上线」的判断**——所有厂商都留在人手里，官方产品默认审批（products.md:12、products.md:172、deepseek-official.md:232）。
2. **发布 / 部署动作**——以显式配置步骤存在，不由 agent 自主决定（products.md:178）。
3. **目标与约束的定义**——由人定义；官方与产品都不代劳（products.md:173）。
4. **模糊 / 探索性任务**——口径不清时先定义再动手，不让 agent 边猜边改（products.md:174、vibe-coding-cn.md:80）。
5. **权限提权与密钥**——不自动提权、不自动读凭据文件（products.md:176、vibe-coding-cn.md:91、vibe-coding-cn.md:95）。
6. **受保护路径与「任何模式都不自动批准」的动作**——单独控制，不随主体授权放行（products.md:177）。
7. **跨写操作的越界**：不覆盖人手动改动、不动不是本流水线创建的分支/工作树（products.md:175）。
8. **无界记忆写入**——记忆必须有条数与长度上限（products.md:179）。
9. **跳过评审直接实现计划**——计划必须先物化、先可评审（products.md:180）。
10. **自动解 Git 冲突**——材料明确要求冲突路径出现时先暂停（vibe-coding-cn.md:101）；我们只保留基线文件的重算。
11. **危险状态清理与绕过门禁**——不 reset / clean / stash / 强推 / 强制切换，不用 `--no-verify`（vibe-coding-cn.md:103、vibe-coding-cn.md:104）。
12. **性能结论的单独裁定**——没有 profiling、baseline、correctness regression 的「性能更好」不接受，也不由 agent 自行宣布（vibe-coding-cn.md:153、vibe-coding-cn.md:160）。
13. **自动化流程自身拿写权限**——官方自己的自动化示例就是只读的，我们对应到 `readonly:ok`（deepseek-official.md:236）。

## 六、未验证与缺口

继承自四份笔记的缺口，按「需要换什么才能补」分类；**「未找到」不等于「不存在」**，这条措辞纪律必须在引用时保留。

### 6.1 需换网络 / 换抓取通道

- **Google Jules 全部内容**：`jules.google/` 与官方博客均连接超时，本轮不做任何事实断言 → 需换网络后补抓（products.md:221、products.md:31）。
- **OpenAI Codex 云端能力、AGENTS.md 注入规则、sandbox 策略**：`developers.openai.com` 对抓取端稳定 403（Akamai），`r.jina.ai` 超时，仓库内对应 docs 是存根 → 需换网络或换代理（products.md:222、top-repos.md:192）。
- **Codex 的 Linux 沙箱实现**：只验证了 macOS seatbelt 与 Windows sandbox 路径存在（top-repos.md:193）。

### 6.2 需换抓取器 / 换数据源

- **字节 Trae 技术文档**：标题可达、正文客户端渲染为空 → 需真浏览器渲染后抓取（products.md:223）。
- **腾讯 CodeBuddy 技术文档**：公开材料只到能力介绍层（products.md:224）。
- **国内产品的权限模式 / 评审归属 / 合入策略**：旧文档路径 404，其余未公开 → 需官方渠道或文档站账号（products.md:225）。
- **Cursor 的 Bugbot / Security Agents / PR Routing & Approval / Rollouts 细节**：只从索引确认页面存在，未逐页抓取（products.md:226）。

### 6.3 需读源码或实测（README 不足）

- **OpenHands 的「防假成功」防线具体实现**：只看到 Metrics / Observability 导航项（top-repos.md:194）。
- **Continue 的沙箱与审批机制**（top-repos.md:195）、**Devon 的沙箱与验证回路**（top-repos.md:196）、**gpt-engineer 是否有审批层**（top-repos.md:197）、**AutoGPT classic 的 approval scope 枚举**（top-repos.md:198）——均需读实现。
- **DeepSeek 侧三处「官方没说」**：长文件截断、必须分步执行、多文件自动改写的准入条件，全部是「未找到官方表述」，不能反推成「官方反对」或「不存在」（deepseek-official.md:216、deepseek-official.md:217、deepseek-official.md:239）。
- **官方公众号原文**：站点只有二维码，无文章列表（deepseek-official.md:218、deepseek-official.md:295）。
- **HuggingFace 上 V4 / V4.1 模型卡与两份技术报告**：抓取超时，未取正文（deepseek-official.md:295）。
- **V4 Pro 定价页与下线公告口径未对齐**：定价页仍列独立单价，公告说已路由到 Flash，实际计费以账单为准（deepseek-official.md:49）。
- **vibe-coding-cn 没有真实失败案例库**，社区经验是推文摘录、原文即标「未经验证」（vibe-coding-cn.md:261、vibe-coding-cn.md:195、vibe-coding-cn.md:198）。

### 6.4 本报告自身引入的缺口（不是笔记的问题）

- **headless agent 的权限档位没有实测依据**：四份笔记都不涉及本机 `--profile headless` 的实际 permission preset，需实测 `dsh --profile headless --dump-config` 后才能对 §3.1 第二条下最终判定。
- **`scripts/test-baseline.txt` 现值是 `92 194`**（两个数：tests=92、asserts=194），与任务书里写的「92 193」差 1；本报告一律以文件现值为准，这个差额需要一次带说明的 `--bless` 或回溯澄清。
- **语义评审的误判率无数据**：`ci/semantic-review.mjs` 的自建程度最高，products.md:161 没有任何一家给出评审误判率或人工抽检比例，需要人工抽检若干 PR 才有口径。
- **`allow:gate` 的授权模型无参照**：四份材料里最接近的只有 products.md:177 与 products.md:26，都不足以支撑「谁、凭什么、批到什么程度」的可执行规则。

### 6.5 下一轮补抓的建议顺序（按补上之后的用处排）

1. **先补 Google Jules**（products.md:221）：它是「云沙箱 + 计划物化 + 事后评审」这条路线唯一缺的一块，补上之后 §二 的「完全自动化形态」才算四路齐全。
2. **再补 Codex 云端与 sandbox 语义**（products.md:222、top-repos.md:192）：它的 approval RPC 四分类是目前唯一把「动作类别」做成一级公民的实现，对我们「哪些动作要单独授权」直接可抄。
3. **然后读实现而非 README**：OpenHands 的假成功防线（top-repos.md:194）、Continue 的沙箱与审批（top-repos.md:195）——这两项直接决定「验收裁决」怎么写才算够。
4. **最后补国内产品**（products.md:223、products.md:225）：优先级最低，因为它们目前不公开权限与合入策略，补到的多半还是营销口径。
5. 补抓时的纪律不变：抓不到就写「未找到」，不写推测；抓取被本地规则误拦时记录拦截原因（本轮已经出过一次，deepseek-official.md:34）。
