#!/usr/bin/env bash
# headless-task.sh — 本机无人值守编程入口
#
# 用法:
#   bash ci/headless-task.sh "任务描述"
#   printf '%s' "任务描述" | bash ci/headless-task.sh -
#
# 它会:
#   1. 从 ~/.dsh/.credentials.yaml 取 SILICONFLOW_API_KEY（不落盘、不回显）
#   2. 用 danger-full-access 权限运行 headless profile（审批策略变为 never，不会卡住）
#   3. 挂上 --patch 覆盖模型路由（默认 siliconflow/Xing4.0-29B）
#
# 为什么需要这个包装: headless profile 默认 provider 是 deepseek-official，
# 需要 DEEPSEEK_API_KEY；本机没有该 key，但有 siliconflow key 和本地 Lemonade。
# 模型路由在 D:\code\.secrets\headless-model.yml 里改。
set -uo pipefail

INSTALL="${DSH_INSTALL:?未设置 DSH_INSTALL：指向 DeepSeek Harness 安装目录}"
DSH_BIN="$INSTALL/resources/runtime/cli/bin/dsh.cmd"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_DIR="${DSH_SECRETS_DIR:-$ROOT/../.secrets}"
PATCH="${DSH_HEADLESS_PATCH:-$SECRETS_DIR/headless-model.yml}"
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

export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"

if [ -z "${SILICONFLOW_API_KEY:-}" ]; then
  SILICONFLOW_API_KEY=$(grep -m1 '^  SILICONFLOW_API_KEY:' "$CREDS" 2>/dev/null \
    | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r\n')
  export SILICONFLOW_API_KEY
fi

if [ "$#" -eq 0 ]; then
  echo "usage: $0 \"task text\"   |   printf '%s' \"task\" | $0 -" >&2
  exit 2
fi

# DSH_HEADLESS_JSON=1 时输出 newline-delimited 事件流（调度器据此统计 token 用量）。
JSON_ARGS=()
if [ "${DSH_HEADLESS_JSON:-}" = "1" ]; then
  JSON_ARGS=(--json)
fi

if [ "$1" = "-" ]; then
  exec "$DSH_BIN" --profile headless --patch "$PATCH" "${JSON_ARGS[@]}" -
fi
exec "$DSH_BIN" --profile headless --patch "$PATCH" "${JSON_ARGS[@]}" "$@"
