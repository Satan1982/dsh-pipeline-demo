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

# GitHub 会间歇性抖（Recv failure / Connection reset）。取不到就用本地已有的
# refs/remotes/origin/main 照推——镜像的意义是「跟上最近一次成功同步」，不是「必须实时」。
SRC=refs/remotes/origin/main
if ! "$GIT" fetch origin main --quiet 2>/dev/null; then
  # GitHub 拉不动时，本地 main 才是最新的事实（调度器就是在本地提交的），直接镜它。
  if "$GIT" rev-parse --verify --quiet refs/heads/main >/dev/null; then
    SRC=refs/heads/main
    echo "GitHub fetch 失败，改用本地 refs/heads/main 镜像" >&2
  elif "$GIT" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
    echo "GitHub fetch 失败，改用本地缓存的 origin/main（可能落后一个提交）" >&2
  else
    echo "GitHub fetch 失败且本地没有任何 main，跳过镜像" >&2
    exit 1
  fi
fi
# 推 $SRC（能 fetch 就用 origin/main，拉不动就用本地 main）
"$GIT" -c credential.helper= push "$REMOTE" "$SRC:refs/heads/main" --tags 2>&1 | tail -3
