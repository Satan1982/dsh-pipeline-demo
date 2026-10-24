#!/usr/bin/env bash
# Single gate entry. Everything that must pass before merge or release runs here.
set -euo pipefail
cd "$(dirname "$0")/.."

BLESS=0
if [ "${1:-}" = "--bless" ]; then
  BLESS=1
fi

BASE_FILE="scripts/test-baseline.txt"

pack() {
  if command -v npm >/dev/null 2>&1; then
    npm pack --silent --pack-destination dist
    return
  fi

  # PNPM_CLI 可能由调度器按错误目录拼出（历史故障指向 node/pnpm/...）。
  # 路径不存在时不要直接让 node 报 MODULE_NOT_FOUND，改为从当前 node 的
  # 安装位置反推随包 pnpm，保证打包步骤不会误杀整个门禁。
  local pnpm_cli="${PNPM_CLI:-}"
  if [ -n "$pnpm_cli" ] && [ ! -f "$pnpm_cli" ]; then
    echo "忽略不存在的 PNPM_CLI：$pnpm_cli（改为自动定位随包 pnpm）" >&2
    pnpm_cli=""
  fi
  if [ -z "$pnpm_cli" ]; then
    local node_path runtime_dir
    node_path=$(command -v node || true)
    if [ -n "$node_path" ]; then
      runtime_dir=$(cd "$(dirname "$node_path")/../.." 2>/dev/null && pwd || true)
      if [ -n "$runtime_dir" ] && [ -f "$runtime_dir/pnpm/bin/pnpm.cjs" ]; then
        pnpm_cli="$runtime_dir/pnpm/bin/pnpm.cjs"
      fi
    fi
  fi
  if [ -z "$pnpm_cli" ]; then
    echo "no packer available: install npm or set PNPM_CLI to a valid pnpm.cjs" >&2
    exit 1
  fi
  node "$pnpm_cli" pack --pack-destination dist
}

echo "== lint =="
bash scripts/lint.sh

echo "== unit test =="
TEST_FILES=$(ls src/*.test.js ci/*.test.mjs | tr '\n' ' ')
echo "running $TEST_FILES"
TEST_OUT=$(node --test --test-reporter=tap $TEST_FILES 2>&1 || true)
printf '%s\n' "$TEST_OUT"

# Node 22 默认输出 TAP（`# tests N`），Node 24 默认输出 spec（`ℹ tests N`）。两种都认。
CUR_TESTS=$(printf '%s\n' "$TEST_OUT" | sed -n -e 's/^# tests \([0-9][0-9]*\)$/\1/p' -e 's/^ℹ tests \([0-9][0-9]*\)$/\1/p' | tail -1)
CUR_FAIL=$(printf '%s\n' "$TEST_OUT" | sed -n -e 's/^# fail \([0-9][0-9]*\)$/\1/p' -e 's/^ℹ fail \([0-9][0-9]*\)$/\1/p' | tail -1)
if [ "${CUR_FAIL:-1}" != "0" ]; then
  echo "unit test 失败：fail=${CUR_FAIL:-unknown}" >&2
  exit 1
fi
if [ -z "${CUR_TESTS:-}" ]; then
  echo "无法解析测试数量（期望 TAP 的 '# tests N' 或 spec 的 'ℹ tests N'）" >&2
  exit 1
fi

CUR_ASSERTS=$(grep -ho 'assert\.' src/*.test.js ci/*.test.mjs | wc -l | tr -d ' ')

echo "== test guard =="
if [ ! -f "$BASE_FILE" ]; then
  echo "缺少 $BASE_FILE；首次建立基线请跑 bash scripts/verify.sh --bless" >&2
  exit 1
fi
BASE_TESTS=$(cut -d' ' -f1 "$BASE_FILE" | tr -d ' \r\n')
BASE_ASSERTS=$(cut -d' ' -f2 "$BASE_FILE" | tr -d ' \r\n')

if [ "$BLESS" = "1" ]; then
  echo "$CUR_TESTS $CUR_ASSERTS" > "$BASE_FILE"
  echo "基线已更新：tests=$CUR_TESTS asserts=$CUR_ASSERTS"
else
  if [ "$CUR_TESTS" -lt "$BASE_TESTS" ]; then
    echo "拒绝：测试数量从 $BASE_TESTS 降到 $CUR_TESTS（禁止删测试凑绿）" >&2
    exit 1
  fi
  if [ "$CUR_ASSERTS" -lt "$BASE_ASSERTS" ]; then
    echo "拒绝：断言数量从 $BASE_ASSERTS 降到 $CUR_ASSERTS（禁止删断言凑绿）" >&2
    exit 1
  fi
  if [ "$CUR_TESTS" -gt "$BASE_TESTS" ] || [ "$CUR_ASSERTS" -gt "$BASE_ASSERTS" ]; then
    echo "拒绝：测试/断言有新增但基线未更新（tests $BASE_TESTS→$CUR_TESTS, asserts $BASE_ASSERTS→$CUR_ASSERTS）" >&2
    echo "新增是好事，但必须同 PR 跑 bash scripts/verify.sh --bless 提交基线，否则新断言不在指纹保护范围内。" >&2
    exit 1
  fi
  echo "基线持平：tests=$CUR_TESTS asserts=$CUR_ASSERTS"
fi

echo "== assert guard =="
if [ "$BLESS" = "1" ]; then
  node scripts/assert-guard.mjs --bless
else
  node scripts/assert-guard.mjs
fi

echo "== build =="
rm -rf dist
node scripts/build.js

echo "== pack =="
pack

echo "== verify: OK =="
