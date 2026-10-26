# Project contract (read before touching code)

## Build / verify commands

- Gate (must pass before merge or release): `bash scripts/verify.sh`
- Lint only: `npm run lint`
- Test only: `npm test`
- Build artifact: `node scripts/build.js` -> `dist/*.tgz` + `dist/build-info.json`

## Rules

- Never weaken or delete a test to make the gate pass. If a test is wrong, fix the test *and* the code in the same PR with a reason in the description.
- **Test baseline is enforced, not advised.** `scripts/test-baseline.txt` holds `<tests> <asserts>`. `verify.sh` refuses to pass when either number *drops* (delete-to-green), and also refuses when either number *grows* without the baseline being updated — so adding tests requires `bash scripts/verify.sh --bless` in the same PR. Lowering the baseline in the same PR that deletes tests is rejected by the CI step "Test baseline must not shrink".
- **Assertion *content* is fingerprinted too.** `scripts/assert-baseline.txt` stores `<count> <sha256-16> <normalized line>` for every `assert.*` line. Locally, rewriting an assertion (even `2` -> `2.0`), deleting one, **or adding one without blessing** fails `assert guard` — a new assertion that is not fingerprinted is unprotected, so additions must be blessed in the same PR. The CI step "Assertion content must not be rewritten" runs the same script against the base branch with `--allow-additions`: additions are fine there (the PR's own baseline already covers them), rewrites and deletions are not. Re-blessing therefore cannot hide a rewritten assertion. To legitimately change an assertion: fix the code first, then run `bash scripts/verify.sh --bless` and say why in the PR.
- Never edit `.github/workflows/*` unless the task is explicitly about CI.
- Do not add a dependency without a license check and a human approval.
- One PR = one vertical slice = runnable end to end.
- Commit subject: short imperative line, no AI attribution, no body unless needed.

## Layout

- `src/` production code + colocated `*.test.js`
- `scripts/verify.sh` the only gate entry
- `.github/workflows/ci.yml` runs on every PR
- `.github/workflows/release.yml` runs on `v*` tags and publishes a GitHub Release

## Known machine quirk

This machine has two git installs. The dsh-ops one at `/ucrt64/bin/git` fails GitHub TLS
with `CRYPT_E_NO_REVOCATION_CHECK`; the system one at `C:/Program Files/Git/cmd/git`
works. Use the system git for anything that talks to GitHub.

The bundled Node at `resources/runtime/primary-runtime/dependencies/node/bin` has no npm;
`scripts/verify.sh` falls back to `pnpm pack` via `PNPM_CLI` when npm is absent.

## Releasing

Token lives outside the repo at `<secrets 目录>\github-token.txt` (never commit it).
Push main and optionally a tag with:

```
bash /d/code/.secrets/gh-push.sh            # main only
bash /d/code/.secrets/gh-push.sh v0.1.1     # main + tag -> triggers release.yml
```

## 自动化出口

- 默认：CI 绿即停，PR 等人工合并（打 tag / 发版永远人工）。
- 工单加 `merge:auto` 标签：CI 绿且 `mergeable_state=clean` 时调度器自己 squash 合并、关单。
- 每个 worktree 里有一份调度器生成的 `.dsh/PLAN.md`（目标/验收标准/验收命令/约束/红线），改代码前先读它。

## 验收与红线（调度器侧）

- 工单必须有 `### 验收命令` 段：调度器自己 `bash -lc` 执行它，`exit 0` 才允许开 PR；确实不需要就加 `acceptance:optional`。
- 验收命令最后一行打印 `VERDICT: PASS` 或 `VERDICT: FAIL <原因>`：`FAIL` 一律失败，`PASS` 但 `exit != 0` 也失败；工单打了 `verdict:strict` 则没有 VERDICT 行直接失败。
- 红线不靠提示词：worktree 的 `core.hooksPath` 指向 `.githooks`，`commit` 时由 `ci/precommit.mjs` 跑机械评审（禁止改 `.github/workflows/`、禁止调试占位符、禁止删测试/断言；改门禁需 `DSH_ALLOW_GATE=1` 且工单带 `allow:gate`）。
- 失败指纹落在 `docs/failures.jsonl`（上限 500 行，超出淘汰最早的），重试时同一指纹的历史修法会回灌给 agent。

## Cloud model access (shared free pool — never hardcode model names)

When an agent in a worktree needs a cloud model (batch work, OCR, vision, translation, cheap long-tail calls), use the
machine-wide free pool instead of guessing a model id:

- Pick: `python C:\Users\Administrator\.dsh\tools\free-models\fm.py pick --kind chat|vision|image|ocr|mt --json`
  (returns only `ok`/`stale`, sorted by latency)
- Report every real use: `fm.py report --model <id> --ok|--fail [--ms N] [--detail "<err>"] --source dsh-pipeline-demo`
- Read `stats.status`: `down` = unusable, `degraded` = fallback only, `stale` = usable with retry.
  429 / 1305 / timeout is rate limiting (retry or switch), not a dead model; 401 / 404 / 400 "model does not exist" is real.
- Registry (shared by all workspaces): `C:\Users\Administrator\.dsh\tools\free-models\free-models.json`.
  Status is refreshed by `Free Model Heartbeat` (30 min) and `Free Model Probe` (daily 07:10); cost is 0.
- Do not add a dependency or a provider key for this: the pool already covers siliconflow / zhipu / modelscope / OVH.
