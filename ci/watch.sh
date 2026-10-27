#!/usr/bin/env bash
# 等一段时间后打印日志尾部，把「反复轮询」收敛成一次调用。
#
#   bash ci/watch.sh 300                     # 等 5 分钟，打印 .logs/dispatch.log 最后 12 行
#   bash ci/watch.sh 300 'issue #8|done'     # 只打印匹配的行（最多 12 行）
#   bash ci/watch.sh 60 '' path/to/other.log # 指定别的日志
#
# 主会话用法：把这条命令丢到后台 job，再 job_output 收口；不要自己 sleep+tail 十几轮。
set -uo pipefail

SECS=${1:-120}
PATTERN=${2:-}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOG=${3:-$ROOT/.logs/dispatch.log}

if [ ! -f "$LOG" ]; then
  echo "日志不存在：$LOG" >&2
  exit 2
fi

BEFORE=$(wc -l < "$LOG")
echo "等待 ${SECS}s，然后读取 $LOG（当前 ${BEFORE} 行）${PATTERN:+，过滤：$PATTERN}"
sleep "$SECS"

AFTER=$(wc -l < "$LOG")
echo "== 等待期间新增 $((AFTER - BEFORE)) 行 =="
if [ -n "$PATTERN" ]; then
  tail -n 600 "$LOG" | grep -E "$PATTERN" | tail -n 12 || echo "（没有匹配 $PATTERN 的行）"
else
  tail -n 12 "$LOG"
fi
