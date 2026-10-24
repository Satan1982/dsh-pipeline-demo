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

DSH="/c/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"
PATCH="${DSH_HEADLESS_PATCH:-D:/code/.secrets/headless-model.yml}"
CREDS="${DSH_CREDENTIALS:-/c/Users/Administrator/.dsh/.credentials.yaml}"

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

if [ "$1" = "-" ]; then
  exec "$DSH" --profile headless --patch "$PATCH" -
fi
exec "$DSH" --profile headless --patch "$PATCH" "$@"
