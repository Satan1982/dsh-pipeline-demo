# dsh-pipeline-demo

Minimal zero-dependency repo used to prove the full loop:

```
commit -> CI gate -> tag v* -> GitHub Release with artifact
```

- `bash scripts/verify.sh` runs the gate locally and in CI.
- Pushing a tag like `v0.1.0` triggers `.github/workflows/release.yml`,
  which re-runs the gate, builds `dist/*.tgz` and publishes a GitHub Release
  with the tarball attached.

## 自动化 AI 编程流水线

这个仓库同时是一条流水线的实现：issue → agent → 门禁 → 评审 → PR。

| 从这里开始 | 内容 |
|---|---|
| [`docs/manual.md`](docs/manual.md) | **使用手册**：怎么开单、怎么启动、标签、巡检、故障处置、成本 |
| [`docs/design-2026-10-28.md`](docs/design-2026-10-28.md) | **架构设计**：分层、七条关键机制、状态机、决策记录、扩展点、红线 |
| [`docs/architecture.md`](docs/architecture.md) | 组件与职责、一次任务的生命周期 |
| [`docs/dispatch.md`](docs/dispatch.md) | 调度器细节：领取、重试、评审、锁、免费池挂起与自动恢复 |
| [`docs/model-policy.md`](docs/model-policy.md) | 模型档位与免费池纪律 |
| [`docs/cost-model.md`](docs/cost-model.md) / [`docs/cost-report.md`](docs/cost-report.md) | 计价口径与成本报表（自动报表在 `.logs/cost-report.md`，`docs/` 里那份是手工快照） |

一条命令起常驻：`node ci/dispatch.mjs --ensure`；开单用 GitHub 的 `自动化任务` 模板。
