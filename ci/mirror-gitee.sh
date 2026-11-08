#!/usr/bin/env bash
# 把 GitHub 的 main 与 tag 镜像到 Gitee（agent 分支不上传，避免两边 PR 语义打架）。
# 只做只读镜像：Gitee 侧不跑 CI、不接受 PR，纯粹让国内拉代码快。
set -uo pipefail
GIT="${DSH_GIT:-C:/Program Files/Git/cmd/git.exe}"
SECRETS="${DSH_SECRETS_DIR:-$(cd "$(dirname "$0")/.." && pwd)/../.secrets}"
# 归一化：带 ".." 的路径交给 GIT_ASKPASS 会让 git 报 "cannot spawn ...: No such file or directory"
# （实测 2026-11-06 19:33，同一文件用 /d/code/.secrets 就正常）。
if [ -d "$SECRETS" ]; then SECRETS="$(cd "$SECRETS" && pwd)"; fi
REMOTE="${DSH_GITEE_REMOTE:-gitee}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

# 本机 PATH 里没有 node/pnpm（见 AGENTS.md），缺失时补随包运行时。
if ! command -v node >/dev/null 2>&1; then
  INSTALL=${DSH_INSTALL:-$HOME/AppData/Local/Programs/DeepSeek Harness}
  export PATH="$INSTALL/resources/runtime/primary-runtime/dependencies/node/bin:$PATH"
fi

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
# v3 P1（docs/89 §六-2）：镜像也是出口，推送前必须验签。
# land.sh 在 push GitHub 前已经验过一次；这里覆盖「单独跑 mirror-gitee.sh」的旁路。
# 链不存在/不覆盖 $SRC → fail-closed；跨机无链时只能用显式开关放行并留痕。
VERIFY="$ROOT/ci/trust/verify.mjs"
CHAIN="$ROOT/.logs/witness.jsonl"
KEY_ARGS=""
if [ -d "$ROOT/governance/keys" ]; then KEY_ARGS="--keys $ROOT/governance/keys"; fi
if ! node "$VERIFY" --chain "$CHAIN" --repo "$ROOT" --head "$SRC" $KEY_ARGS >/dev/null 2>&1; then
  if [ "${DSH_GITEE_ALLOW_UNVERIFIED:-0}" = "1" ]; then
    echo "Gitee 镜像：$SRC 验签未通过，但 DSH_GITEE_ALLOW_UNVERIFIED=1，放行并留痕" >&2
    mkdir -p "$ROOT/.logs"
    printf '{"at":"%s","src":"%s","reason":"%s"}\n' \
      "$(date -Iseconds)" "$SRC" "${DSH_GITEE_ALLOW_UNVERIFIED_REASON:-手动放行}" \
      >> "$ROOT/.logs/gitee-unverified.jsonl" 2>/dev/null || true
  else
    echo "Gitee 镜像：$SRC 未被 witness 覆盖，拒绝推送；如确认要推，设 DSH_GITEE_ALLOW_UNVERIFIED=1 并写理由" >&2
    exit 2
  fi
fi

# 推 $SRC（能 fetch 就用 origin/main，拉不动就用本地 main）
"$GIT" -c credential.helper= push "$REMOTE" "$SRC:refs/heads/main" --tags 2>&1 | tail -3
