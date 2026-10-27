#!/usr/bin/env bash
# 跨切片集成验收：跑 docs/specs/<slug>/integration.md 里所有 bash 代码块。
# 没有 integration.md 时退化成全量门禁（bash scripts/verify.sh）。
# 用法：bash scripts/integration.sh <slug>    # 不给 slug 就跑全量门禁
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLUG="${1:-}"
DOC="$ROOT/docs/specs/$SLUG/integration.md"

if [ -z "$SLUG" ] || [ ! -f "$DOC" ]; then
  echo "== 没有 integration.md（slug=${SLUG:-<空>}），退回全量门禁 =="
  exec bash "$ROOT/scripts/verify.sh"
fi

echo "== 集成验收：$DOC =="
python - "$DOC" > /tmp/integration-$$.sh <<'PY'
import io, re, sys
text = io.open(sys.argv[1], encoding='utf-8').read()
blocks = re.findall(r'```bash\s*\n(.*?)```', text, re.S)
print('set -e')
for b in blocks:
    print(b.strip())
    print('')
PY
CODE=$(cat /tmp/integration-$$.sh)
if [ -z "${CODE//[$'\n' ]/}" ]; then
  echo "integration.md 里没有 bash 代码块，退回全量门禁"
  rm -f /tmp/integration-$$.sh
  exec bash "$ROOT/scripts/verify.sh"
fi
bash /tmp/integration-$$.sh
rc=$?
rm -f /tmp/integration-$$.sh
echo "== 集成验收退出码 $rc =="
exit $rc
