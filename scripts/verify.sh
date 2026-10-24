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
  elif [ -n "${PNPM_CLI:-}" ]; then
    node "$PNPM_CLI" pack --pack-destination dist
  else
    echo "no packer available: install npm or set PNPM_CLI to pnpm.cjs" >&2
    exit 1
  fi
}

echo "== lint =="
bash scripts/lint.sh

echo "== unit test =="
TEST_FILES=$(ls src/*.test.js)
echo "running $TEST_FILES"
TEST_OUT=$(node --test $TEST_FILES 2>&1 || true)
printf '%s\n' "$TEST_OUT"

CUR_TESTS=$(printf '%s\n' "$TEST_OUT" | sed -n 's/^ℹ tests \([0-9][0-9]*\)$/\1/p' | tail -1)
CUR_FAIL=$(printf '%s\n' "$TEST_OUT" | sed -n 's/^ℹ fail \([0-9][0-9]*\)$/\1/p' | tail -1)
if [ "${CUR_FAIL:-1}" != "0" ]; then
  echo "unit test 失败：fail=${CUR_FAIL:-unknown}" >&2
  exit 1
fi

CUR_ASSERTS=$(grep -ho 'assert\.' src/*.test.js | wc -l | tr -d ' ')

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
    echo "基线可上调：tests $BASE_TESTS→$CUR_TESTS, asserts $BASE_ASSERTS→$CUR_ASSERTS（确认后跑 bash scripts/verify.sh --bless）"
  else
    echo "基线持平：tests=$CUR_TESTS asserts=$CUR_ASSERTS"
  fi
fi

echo "== build =="
rm -rf dist
node scripts/build.js

echo "== pack =="
pack

echo "== verify: OK =="
