#!/usr/bin/env bash
# 把 GitHub 的 main 与 tag 镜像到 Gitee（agent 分支不上传，避免两边 PR 语义打架）。
# 只做只读镜像：Gitee 侧不跑 CI、不接受 PR，纯粹让国内拉代码快。
set -uo pipefail
GIT="${DSH_GIT:-C:/Program Files/Git/cmd/git.exe}"
SECRETS="${DSH_SECRETS_DIR:-$(cd "$(dirname "$0")/.." && pwd)/../.secrets}"
REMOTE="${DSH_GITEE_REMOTE:-gitee}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

if [ ! -f "$SECRETS/gitee-token.txt" ]; then
  echo "没有 $SECRETS/gitee-token.txt，跳过 Gitee 镜像" >&2
  exit 0
fi
export GIT_ASKPASS="$SECRETS/gitee-askpass.sh" GIT_TERMINAL_PROMPT=0

"$GIT" fetch origin main --quiet || { echo "fetch origin 失败，跳过镜像" >&2; exit 1; }
# 用远端引用直接推，避开本地 main 可能落后/领先的问题
"$GIT" -c credential.helper= push "$REMOTE" refs/remotes/origin/main:refs/heads/main --tags 2>&1 | tail -3
