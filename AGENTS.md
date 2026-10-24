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

Token lives outside the repo at `D:\code\.secrets\github-token.txt` (never commit it).
Push main and optionally a tag with:

```
bash /d/code/.secrets/gh-push.sh            # main only
bash /d/code/.secrets/gh-push.sh v0.1.1     # main + tag -> triggers release.yml
```
