# 无人值守编程入口（headless）

本机 DSH 自带 `headless` profile：**回答一个任务、把结果打到 stdout、然后退出**，
不需要交互式 TUI。这是把 AI 编程自动化的执行器。

## 实测结果（2026-10-24，均为真实运行）

| 验证项 | 结果 | 证据 |
|---|---|---|
| headless 可启动 | ✅ | `dsh headless --help` 正常解析 profile |
| 工具齐全 | ✅ | dump-config 含 bash/pwsh/fs/fs-search/subagent/workflow/todo |
| 无人值守不卡审批 | ✅ | `DSH_PERMISSION_MODE=danger-full-access` → approval policy `never`（**2026-11-06 起默认改为 `workspace-write`，见下节**） |
| 读代码 + 改代码 | ✅ | 43s 内新增 `subtract()` 并补 4 条断言（含负数） |
| 自己跑门禁 | ✅ | 自己发现 `PNPM_CLI` 缺失并补上，`verify: OK` |
| 自己提交 + 推送 | ✅ | commit `d642993`，`afef1ab..d642993 main -> main`，`PUSH_OK` |
| 云端 CI 验证 | ✅ | 该 commit 的 Actions `completed / success` |
| 总耗时 | ~2.5 分钟 | 43s 编码 + 63s 提交推送 + ~40s CI |

## 用法

```bash
# 直接传任务（短任务）
bash ci/headless-task.sh "运行 bash scripts/verify.sh 并只报告结果"

# 长任务/中文任务走 stdin，避免 Windows cmd 引号解析问题
printf '%s' "在 src/index.js 加 subtract 并补测试，然后跑 verify.sh" | bash ci/headless-task.sh -
```

## 为什么需要这个包装脚本

`headless` profile 默认 provider 是 `deepseek-official`，需要 `DEEPSEEK_API_KEY`，本机没有。
包装脚本做三件事（**2026-11-06 起默认档已改为「无凭据 + 本地模型」**）：

1. 默认**不注入任何真实 key**：挂仓内 `ci/headless-local.yml`，路由到 `127.0.0.1:13305` 的 Lemonade（默认档 `Qwen3.5-9B`：本机 20GB 卡放不下 30B 与 Hindsight 的 9B 共存，30B 会被反复顶掉，见 `ci/local-lane.mjs` 头注释）。`LEMONADE_API_KEY` 只是 OpenAI 兼容层要求的占位符，不是秘密。
2. 默认 `DSH_PERMISSION_MODE=workspace-write`（原来是 `danger-full-access`）：越界写被沙箱拒绝，fail-closed 而不是「什么都让它写」。
3. 只有 `DSH_HEADLESS_ALLOW_CREDS=1` 时才回退旧行为：从 `~/.dsh/.credentials.yaml` 取 key（不落盘、不回显），默认 patch 换回 `<secrets 目录>/headless-model.yml`。传这个开关的有两类：工单显式打 `model:strong` / `model:paid`（`ci/dispatch.mjs:943`），以及 **rebase 解冲突路径**（`ci/dispatch.mjs:1559`，默认就用强模型）——这是全流程里唯一默认会碰凭据的一步。

`DSH_HEADLESS_DRY=1 bash ci/headless-task.sh x` 可干跑打印 5 行（mode / keys / patch / patch_exists / lemonade），不启动 agent、不消耗 token。`lemonade=on` 只表示「本地路由已启用」，**不探活**；真探活见下一行。

`DSH_HEADLESS_DRY=1` 在 keys 关闭时会对 Lemonade 做一次 2 秒探活，失败只往 stderr 打一行 `⚠ Lemonade 探活失败`，不改那 5 行输出（那是给机器的契约）。

模型路由改 `ci/headless-local.yml` 的 `agent-default-model`；要换回云端强模型，显式设 `DSH_HEADLESS_ALLOW_CREDS=1` 并改 `<secrets 目录>/headless-model.yml`。

## 模型可用性（实测）

| 路由 | 状态 | 说明 |
|---|---|---|
| siliconflow / Xing4.0-29B | ✅ 可用 | 免费、256K 上下文，小任务 10–60s |
| siliconflow / DeepSeek-V4.1-Flash | ✅ 可用 | 1.7–2.2s 首字，跨多文件的复杂任务明显更稳，按量计费 |
| siliconflow / Kimi-K2.7-Code | ✅ 可用 | 1.7s，代码向；备用 |
| zhipu / glm-4.7-flash | ⚠️ 可用但限流 | 多次触发 `429 code 1305`，不适合无人值守 |
| lemonade 本地 30B | ⚠️ 排队 | 单 slot 被 Hindsight 抽取占用时，请求直接挂住（实测 90s 超时） |

切换强模型：`DSH_HEADLESS_PATCH=<secrets 目录>/headless-model-strong.yml bash ci/headless-task.sh -`。
调度器里给 issue 加 `model:strong` label 即可自动切换，见 `docs/dispatch.md`。

## 已知坑

- **别用反斜杠续行 + 长中文参数**：会让 `dsh.cmd` 的路径在空格处被 cmd.exe 拆开，报
  `'C:\...\DeepSeek' 不是内部或外部命令`。用 `-` 从 stdin 读任务。
- 提交推送让 agent 自己调 `bash /d/code/.secrets/gh-push.sh`，凭据由脚本内部处理。
- `time` 前缀包装 `dsh.cmd` 也会触发同样的路径拆分错误，别用。
