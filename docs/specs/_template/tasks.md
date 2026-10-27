# 任务分解：<功能名>

> 复制到 `docs/specs/<功能名>/tasks.md`。`node ci/plan.mjs <功能名> --dry` 预览要建的 issue，
> 去掉 `--dry` 就真建（每行一张单，依赖自动变成 `dep-on:T1` 标签，调度器只在前置关闭后才开工）。

| 任务 | 说明 | 依赖 | 验收命令 |
|---|---|---|---|
| T1 | 数据模型与存储层 | - | `node --input-type=module -e "…console.log('VERDICT: PASS')"` |
| T2 | 核心接口 | T1 | `node --input-type=module -e "…VERDICT: PASS"` |
| T3 | 集成验收 | T1,T2 | `bash scripts/integration.sh <功能名>` |

规则：
- 验收命令必须自己打印 `VERDICT: PASS` 或 `VERDICT: FAIL <原因>`；写不出来说明任务没定义清楚。
- 一张单对应一个可独立发布的小切片；依赖写全，别靠「反正会先跑」。
