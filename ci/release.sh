#!/usr/bin/env bash
# 一条命令发版：改版本号 -> 跑门禁 -> 提交 -> 打 tag -> 推送。
# 推送 tag 会触发 .github/workflows/release.yml，由 CI 生成 GitHub Release 并上传 dist 里的 tgz。
#
#   bash ci/release.sh            # patch：0.1.0 -> 0.1.1
#   bash ci/release.sh minor      # 0.1.0 -> 0.2.0
#   bash ci/release.sh major      # 0.1.0 -> 1.0.0
#   bash ci/release.sh patch --push   # 真的推；不带 --push 只做到本地 tag
#
# 为什么要脚本：发版是唯一一件「人说了算、但步骤机械」的事。步骤写成脚本，
# 就不会漏跑门禁、不会忘记打 tag、不会把 tag 打在没验证的提交上。
set -u
cd "$(dirname "$0")/.." || exit 1

BUMP="${1:-patch}"
PUSH=0
for a in "$@"; do [ "$a" = "--push" ] && PUSH=1; done

GIT_BIN="${GIT_BIN:-C:/Program Files/Git/cmd/git}"
NODE_BIN="${DSH_NODE:-C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe}"
export PNPM_CLI="${PNPM_CLI:-C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs}"

echo "== 1. 工作区必须干净 =="
if [ -n "$("$GIT_BIN" status --porcelain)" ]; then
  echo "✗ 工作区有未提交改动，先提交或 stash" >&2
  "$GIT_BIN" status --short >&2
  exit 1
fi

echo "== 2. 门禁 =="
if ! bash scripts/verify.sh >/tmp/release-verify.log 2>&1; then
  echo "✗ 门禁未通过，发版中止：" >&2
  tail -n 20 /tmp/release-verify.log >&2
  exit 1
fi
tail -n 1 /tmp/release-verify.log

echo "== 3. 改版本号（$BUMP）=="
NEW="$("$NODE_BIN" -e '
const fs = require("node:fs");
const path = "package.json";
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
const [maj, min, pat] = String(pkg.version).split(".").map(Number);
const how = process.argv[1];
const next = how === "major" ? [maj + 1, 0, 0] : how === "minor" ? [maj, min + 1, 0] : [maj, min, pat + 1];
pkg.version = next.join(".");
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
process.stdout.write(pkg.version);
' "$BUMP")" || exit 1
TAG="v$NEW"
echo "新版本：$TAG"

echo "== 4. 提交 + 打 tag =="
"$GIT_BIN" add package.json || exit 1
"$GIT_BIN" commit -q -m "Release $TAG" || exit 1
"$GIT_BIN" tag -a "$TAG" -m "Release $TAG" || exit 1
"$GIT_BIN" log --oneline -1

if [ "$PUSH" != 1 ]; then
  echo "已在本地产出 $TAG（未推送）。确认没问题后执行："
  echo "  bash ci/release.sh $BUMP --push   # 或在已有 tag 上直接："
  echo "  git push origin main && git push origin $TAG"
  exit 0
fi

echo "== 5. 推送（github.com:443 会抖，退避重试）=="
TOKEN_FILE="${GH_TOKEN_FILE:-/d/code/.secrets/github-token.txt}"
if [ -r "$TOKEN_FILE" ]; then
  export GIT_ASKPASS="${GIT_ASKPASS:-/d/code/.secrets/askpass.sh}"
  export GIT_TOKEN="$(tr -d ' \r\n\t' < "$TOKEN_FILE")"
  export GIT_TERMINAL_PROMPT=0
fi
for i in $(seq 1 8); do
  if "$GIT_BIN" -c credential.helper= push origin main && "$GIT_BIN" -c credential.helper= push origin "$TAG"; then
    echo "✅ 已推送 $TAG，release.yml 会生成 Release"
    REMOTE="$("$GIT_BIN" remote get-url origin | sed -E 's#^https://[^/]+/##; s#\.git$##')"
    echo "   https://github.com/$REMOTE/releases/tag/$TAG"
    exit 0
  fi
  echo "push 第 $i 次失败，20 秒后重试…"
  sleep 20
done
echo "✗ 推送失败：本地的 $TAG 已打好，网络恢复后手动 git push origin main && git push origin $TAG" >&2
exit 1
