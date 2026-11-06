#!/usr/bin/env bash
# headless-task.sh — 本机无人值守编程入口
#
# 用法:
#   bash ci/headless-task.sh "任务描述"
#   printf '%s' "任务描述" | bash ci/headless-task.sh -
#   DSH_HEADLESS_DRY=1 bash ci/headless-task.sh "任务描述"   # 只打印将生效的路由/权限，不跑
#
# 它会:
#   1. 挂本地模型路由 patch（默认 ci/headless-local.yml → 127.0.0.1:13305 的 Lemonade），
#      **默认不注入任何真实 API key**（agent 不该持凭据，docs/76 §13 S1）
#   2. 默认 workspace-write 权限档（不再是 danger-full-access，§13 S2）
#   3. DSH_HEADLESS_ALLOW_CREDS=1 时才回退到旧行为：从 ~/.dsh/.credentials.yaml 取 key
#      （不落盘、不回显），并把默认 patch 换回 $SECRETS_DIR/headless-model.yml
#
# 为什么默认改本地: 之前这个入口既注入 3 把真 key，又给 danger-full-access，
# 等于把 .secrets 交给一个自动改代码的进程。真实隔离要低权用户（§13 S4），
# 那之前至少先做到「手里没有真东西」——手里没 key 就没有泄漏面。
set -uo pipefail

INSTALL="${DSH_INSTALL:?未设置 DSH_INSTALL：指向 DeepSeek Harness 安装目录}"
DSH_BIN="$INSTALL/resources/runtime/cli/bin/dsh.cmd"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="${DSH_SECRETS_DIR:-$ROOT/../.secrets}"
CREDS="${DSH_CREDENTIALS:-$HOME/.dsh/.credentials.yaml}"

# 计划任务（以及任何干净 shell）里 PATH 没有 node，也没有 PNPM_CLI：
# verify.sh 的 pack 步骤会因为没有包管理器而失败。这里自己补齐，让入口自足。
BUNDLE="$INSTALL/resources/runtime/primary-runtime/dependencies"
if [ -d "$BUNDLE/node/bin" ]; then
  case ":$PATH:" in
    *":$BUNDLE/node/bin:"*) ;;
    *) export PATH="$BUNDLE/node/bin:$PATH" ;;
  esac
fi
export PNPM_CLI="${PNPM_CLI:-$BUNDLE/pnpm/bin/pnpm.cjs}"

export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-workspace-write}"

ALLOW_CREDS="${DSH_HEADLESS_ALLOW_CREDS:-0}"
if [ "$ALLOW_CREDS" = "1" ]; then
  # 旧行为（显式 opt-in）：需要真 key 的路由才走这里。默认 patch 也跟着回到 .secrets 那份。
  PATCH="${DSH_HEADLESS_PATCH:-$SECRETS_DIR/headless-model.yml}"
  if [ -z "${SILICONFLOW_API_KEY:-}" ]; then
    SILICONFLOW_API_KEY=$(grep -m1 '^  SILICONFLOW_API_KEY:' "$CREDS" 2>/dev/null \
      | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r\n')
    export SILICONFLOW_API_KEY
  fi
  if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
    _ds=$(grep -m1 '^  DEEPSEEK_API_KEY:' "$CREDS" 2>/dev/null | sed 's/^[^:]*:[[:space:]]*//' | tr -d ' \r\n')
    if [ -n "$_ds" ]; then DEEPSEEK_API_KEY="$_ds"; export DEEPSEEK_API_KEY; fi
    unset _ds
  fi
  if [ -z "${MODELSCOPE_API_TOKEN:-}" ]; then
    _ms=$(grep -m1 '^  MODELSCOPE_API_TOKEN:' "$CREDS" 2>/dev/null | sed 's/^[^:]*:[[:space:]]*//' | tr -d ' \r\n')
    if [ -n "$_ms" ]; then MODELSCOPE_API_TOKEN="$_ms"; export MODELSCOPE_API_TOKEN; fi
    unset _ms
  fi
else
  # 默认：本地 Lemonade，无真 key。LEMONADE_API_KEY 只是 OpenAI 兼容层要求的占位符，不是秘密。
  PATCH="${DSH_HEADLESS_PATCH:-$ROOT/ci/headless-local.yml}"
  export LEMONADE_API_KEY="${LEMONADE_API_KEY:-lemonade-local}"
fi

if [ "${DSH_HEADLESS_DRY:-}" = "1" ]; then
  # 那 5 行是给机器读的契约，别往里加字段；探活结果只走 stderr。
  echo "mode=$DSH_PERMISSION_MODE"
  echo "keys=$([ "$ALLOW_CREDS" = "1" ] && echo on || echo off)"
  echo "patch=$PATCH"
  echo "patch_exists=$([ -f "$PATCH" ] && echo yes || echo no)"
  echo "lemonade=$([ "$ALLOW_CREDS" = "1" ] && echo off || echo on)"
  if [ "$ALLOW_CREDS" != "1" ]; then
    # lemonade=on 只说路由选的是本地，不代表端点活着。默认档唯一的模型端点掉线时，
    # 否则整条流水线只会表现为「agent exit≠0」，没人知道是模型没起来。
    _probe=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "${LEMONADE_BASE:-http://127.0.0.1:13305/api/v1}/models" 2>/dev/null || true)
    [ "$_probe" = "200" ] || echo "⚠ Lemonade 探活失败 HTTP=${_probe:-000}（默认档唯一模型端点，agent 会起不来）" >&2
  fi
  exit 0
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 \"task text\"   |   printf '%s' \"task\" | $0 -" >&2
  exit 2
fi

if [ ! -f "$PATCH" ]; then
  echo "模型路由 patch 不存在：$PATCH（本地默认应为 ci/headless-local.yml）" >&2
  exit 1
fi

# DSH_HEADLESS_JSON=1 时输出 newline-delimited 事件流（调度器据此统计 token 用量）。
JSON_ARGS=()
if [ "${DSH_HEADLESS_JSON:-}" = "1" ]; then
  JSON_ARGS=(--json)
fi

# DSH_SESSION_ID 只用来「接着上一次没跑完的会话跑」：限流/进程启动失败这类环境噪声时，
# 复用同一个 session 比每次重新开一个更省上下文，也不会在 ~/.dsh/sessions 里再堆一个目录。
#
# 但它是**宿主进程自己也会设**的变量：从某个 DSH 会话的 shell 里手工调用这个脚本时，
# 环境里已经带着那个会话的 id，一旦拿去 --session-id 就会被 headless runner 拒绝
# （"runs under an agent preset the one-shot runner does not compose"）。
# 所以只认显式开关：调度器续跑时同时设 DSH_HEADLESS_RESUME=1（ci/dispatch.mjs 的 runEnv）。
SESSION_ARGS=()
if [ -n "${DSH_HEADLESS_RESUME:-}" ] && [ -n "${DSH_SESSION_ID:-}" ]; then
  SESSION_ARGS=(--session-id "$DSH_SESSION_ID")
elif [ -n "${DSH_SESSION_ID:-}" ]; then
  echo "⚠ 忽略继承来的 DSH_SESSION_ID（不是本入口要续的会话；需要续跑请同时设 DSH_HEADLESS_RESUME=1）" >&2
fi

# 别用 dsh.cmd 传任务：它是 .cmd 批处理，任务文本里的 `<` `>`（比如要写 HTML 注释）
# 会被 cmd.exe 当成重定向，报「系统找不到指定的文件」而不是跑任务（2026-11-06 实测）。
# 直接起 Electron 的 node 入口，参数不经过 cmd.exe 解析。
DSH_EXE="$INSTALL/DeepSeek Harness.exe"
DSH_CLI="$INSTALL/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
run_headless() {
  # 只查 exe：cli.js 在 app.asar 里，bash 的 -f 看不到它。
  if [ -x "$DSH_EXE" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$DSH_EXE" --expose-internals "$DSH_CLI"       --profile headless --patch "$PATCH" "${SESSION_ARGS[@]}" "${JSON_ARGS[@]}" "$@"
  fi
  exec "$DSH_BIN" --profile headless --patch "$PATCH" "${SESSION_ARGS[@]}" "${JSON_ARGS[@]}" "$@"
}

if [ "$1" = "-" ]; then
  run_headless -
fi
run_headless "$@"
