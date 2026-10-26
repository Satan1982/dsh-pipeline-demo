#!/usr/bin/env bash
# Syntax check every JS module we own. Kept separate so both npm and CI can call it.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
for f in src/*.js scripts/*.js ci/*.mjs; do
  [ -e "$f" ] || continue
  if ! node --check "$f"; then
    echo "syntax error: $f" >&2
    fail=1
  fi
done
[ "$fail" -eq 0 ] || exit 1
echo "lint OK ($(ls src/*.js scripts/*.js ci/*.mjs | wc -l | tr -d ' ') files)"

# 用了模块却没 import 这类问题 node --check 查不出来（2026-10-26 连挂三次）。
node scripts/check-imports.mjs
