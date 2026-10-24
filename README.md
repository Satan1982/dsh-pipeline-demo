# dsh-pipeline-demo

Minimal zero-dependency repo used to prove the full loop:

```
commit -> CI gate -> tag v* -> GitHub Release with artifact
```

- `bash scripts/verify.sh` runs the gate locally and in CI.
- Pushing a tag like `v0.1.0` triggers `.github/workflows/release.yml`,
  which re-runs the gate, builds `dist/*.tgz` and publishes a GitHub Release
  with the tarball attached.
