#!/usr/bin/env bash
# 一条命令把改动落到两个远端：门禁 -> 提交 -> 推送（https 失败自动走 SSH）-> 镜像 Gitee。
#
# 为什么要有它：主会话里「verify、git add、commit、push、push 失败改 ssh、mirror」原来是 4~6 轮，
# 每轮都要一次模型往返。收敛成一次调用后，机械动作不再占用主会话的思考时间。
#
#   bash ci/land.sh "提交说明"            # 默认：门禁 + 提交 + 推送 + 镜像
#   DSH_ALLOW_GATE=1 bash ci/land.sh "…"  # 确需改门禁脚本时放行（会在输出里标明）
#   DSH_LAND_PUSH=0 bash ci/land.sh "…"   # 只提交不推送
#   DSH_LAND_ALL=1 bash ci/land.sh "…"    # 连未跟踪的新文件一起收（默认只收已跟踪文件的改动）
#
# 失败即停（set -e），并打印失败那一步的原话，不吞错误。
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

MSG=${1:-}
if [ -z "$MSG" ]; then
  echo "用法: bash ci/land.sh \"提交说明\"" >&2
  exit 2
fi

# 本机 PATH 里没有 node/pnpm（见 AGENTS.md），缺失时补随包运行时。
if ! command -v node >/dev/null 2>&1; then
  INSTALL=${DSH_INSTALL:-$HOME/AppData/Local/Programs/DeepSeek Harness}
  export PATH="$INSTALL/resources/runtime/primary-runtime/dependencies/node/bin:$PATH"
  export PNPM_CLI=${PNPM_CLI:-$INSTALL/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs}
fi

GIT=${DSH_GIT:-"C:/Program Files/Git/cmd/git.exe"}
SECRETS=${DSH_SECRETS_DIR:-$(dirname "$ROOT")/.secrets}
REMOTE=${DSH_LAND_REMOTE:-https://github.com/Satan1982/dsh-pipeline-demo.git}
SSH_REMOTE=${DSH_LAND_SSH_REMOTE:-ssh://git@ssh.github.com:443/Satan1982/dsh-pipeline-demo.git}

echo "== 1/4 门禁 =="
bash scripts/verify.sh

echo "== 2/4 提交 =="
# 只暂存「已跟踪文件」的改动。原来是 `git add -A`：任何自动生成的产物（成本报表、尝试日志
# 之外的临时脚本）都会被顺手卷进下一次提交，2026-10-28 实测一个 95 行的报表噪声就是这样进仓库的。
# 未跟踪的新文件需要明确放行：DSH_LAND_ALL=1（或先自己 `git add <文件>`）。
"$GIT" add -u
UNTRACKED=$("$GIT" ls-files --others --exclude-standard)
if [ -n "$UNTRACKED" ]; then
  echo "有未跟踪文件，本次默认不提交："
  printf '%s\n' "$UNTRACKED" | sed 's/^/  /'
  if [ "${DSH_LAND_ALL:-0}" = "1" ]; then
    echo "（DSH_LAND_ALL=1：一并收进本次提交）"
    "$GIT" add -A
  else
    echo "要一起提交：DSH_LAND_ALL=1 bash ci/land.sh \"提交说明\"（或先 git add <文件>）"
  fi
fi
if "$GIT" diff --cached --quiet; then
  echo "没有待提交的改动，跳过提交"
else
  if [ -n "${DSH_ALLOW_GATE:-}" ]; then
    echo "（DSH_ALLOW_GATE=$DSH_ALLOW_GATE：按 allow:gate 放行门禁脚本改动，合并前仍请人工确认）"
    DSH_ALLOW_GATE="$DSH_ALLOW_GATE" "$GIT" commit -q -m "$MSG"
  else
    "$GIT" commit -q -m "$MSG"
  fi
fi
HEAD_SHA=$("$GIT" rev-parse --short HEAD)
echo "已提交 $HEAD_SHA"

if [ "${DSH_LAND_PUSH:-1}" = "0" ]; then
  echo "DSH_LAND_PUSH=0：只提交，不推送"
  exit 0
fi

echo "== 3/4 推送 =="
PUSHED=0
if [ -f "$SECRETS/github-token.txt" ] && [ -f "$SECRETS/askpass.sh" ]; then
  for attempt in 1 2 3; do
    if GIT_ASKPASS="$SECRETS/askpass.sh" \
       GIT_TOKEN="$(tr -d ' \r\n\t' < "$SECRETS/github-token.txt")" \
       GIT_TERMINAL_PROMPT=0 \
       "$GIT" -c credential.helper= push "$REMOTE" main; then
      PUSHED=1
      break
    fi
    echo "https 第 $attempt 次没推上去，等 8 秒重试"
    sleep 8
  done
fi

if [ "$PUSHED" != "1" ]; then
  echo "https 推不上去，改走 SSH 端点"
  if [ -f "$SECRETS/ssh-git.sh" ]; then
    GIT_SSH_COMMAND="$SECRETS/ssh-git.sh" GIT_SSH_VARIANT=ssh \
      "$GIT" push "$SSH_REMOTE" main
    PUSHED=1
  else
    echo "缺少 $SECRETS/ssh-git.sh，放弃推送" >&2
    exit 1
  fi
fi

echo "== 4/4 镜像 Gitee =="
if [ -f ci/mirror-gitee.sh ]; then
  bash ci/mirror-gitee.sh || echo "镜像失败（不影响 GitHub）"
fi

echo "== 完成 =="
"$GIT" log -1 --format='commit=%h %s'
