# Project contract (read before touching code)

## Build / verify commands

- Gate (must pass before merge or release): `bash scripts/verify.sh`
- Lint only: `npm run lint`
- Test only: `npm test`
- Build artifact: `node scripts/build.js` -> `dist/*.tgz` + `dist/build-info.json`

## Rules

- Never weaken or delete a test to make the gate pass. If a test is wrong, fix the test *and* the code in the same PR with a reason in the description.
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
