# 无人值守编程入口（headless）

本机 DSH 自带 `headless` profile：**回答一个任务、把结果打到 stdout、然后退出**，
不需要交互式 TUI。这是把 AI 编程自动化的执行器。

## 实测结果（2026-10-24，均为真实运行）

| 验证项 | 结果 | 证据 |
|---|---|---|
| headless 可启动 | ✅ | `dsh headless --help` 正常解析 profile |
| 工具齐全 | ✅ | dump-config 含 bash/pwsh/fs/fs-search/subagent/workflow/todo |
| 无人值守不卡审批 | ✅ | `DSH_PERMISSION_MODE=danger-full-access` → approval policy `never` |
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
包装脚本做三件事：

1. 从 `~/.dsh/.credentials.yaml` 取 `SILICONFLOW_API_KEY`（不回显、不落盘）
2. `DSH_PERMISSION_MODE=danger-full-access` → 审批策略 `never`，否则无人值守会挂在审批上
3. `--patch D:/code/.secrets/headless-model.yml` 覆盖模型路由

模型路由改 `D:/code/.secrets/headless-model.yml` 里的 `agent-default-model`。

## 模型可用性（实测）

| 路由 | 状态 | 说明 |
|---|---|---|
| siliconflow / Xing4.0-29B | ✅ 可用 | 免费、256K 上下文，小任务 10–60s |
| zhipu / glm-4.7-flash | ⚠️ 可用但限流 | 多次触发 `429 code 1305`，不适合无人值守 |
| lemonade 本地 30B | ⚠️ 排队 | 单 slot 被 Hindsight 抽取占用时，请求直接挂住（实测 90s 超时） |

## 已知坑

- **别用反斜杠续行 + 长中文参数**：会让 `dsh.cmd` 的路径在空格处被 cmd.exe 拆开，报
  `'C:\...\DeepSeek' 不是内部或外部命令`。用 `-` 从 stdin 读任务。
- 提交推送让 agent 自己调 `bash /d/code/.secrets/gh-push.sh`，凭据由脚本内部处理。
- `time` 前缀包装 `dsh.cmd` 也会触发同样的路径拆分错误，别用。
