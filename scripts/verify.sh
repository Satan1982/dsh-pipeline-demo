#!/usr/bin/env bash
# Single gate entry. Everything that must pass before merge or release runs here.
set -euo pipefail
cd "$(dirname "$0")/.."

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
if command -v npm >/dev/null 2>&1; then
  npm run --silent lint
else
  node --check src/index.js
  node --check src/index.test.js
fi

echo "== unit test =="
node --test src/index.test.js

echo "== build =="
rm -rf dist
node scripts/build.js

echo "== pack =="
pack

echo "== verify: OK =="
