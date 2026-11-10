# 五个阻塞工单处置（2026-11-10）

## 结论

交接单第 38 代列的五个阻塞工单 **#91 #94 #105 #106 #107 早已全部关闭**，没有需要重投的活。
上一代看到的「阻塞」来自本地 `.logs/blocked-state.json` 的 17 条陈旧记录：那份文件是运行时状态
（只按 7 天保留期淘汰，不看 GitHub 状态），不是台账。处置方式因此不是重投，而是清理 + 留档：

- GitHub 上 0 open issue、0 open PR，`recoverBlocked` 自 11-08 23:17 起就没有可扫的单；
- 14 张已关闭工单上的 `agent:blocked` 残留标签已删除（删除前 14 张，删除后 0 张）；
- `blocked-state.json` 清空为 `{}`，调度器下一拍重写仍为 `{}`；
- `scripts/verify.sh` 仍 `VERDICT: PASS`。

## 逐单

| 单 | 状态 | 关闭时间 | 最后结局 | 交付是否落地 | 处置 |
|---|---|---|---|---|---|
| #91 truncateWords | closed `agent:failed` | 11-06T12:46 | 3 次尝试全空（agent-exit-1 / agent-no-change / 门禁 SyntaxError） | 是：同类实现由 PR #72（`382883e`）合入 `src/text.js:22` | 关闭即终态；保留 `agent:failed` 作历史 |
| #94 slugify | closed `agent:done` | 11-06T16:52 | 免费池跑通 | 是：`cae1488` 合入 `src/text.js:97` | 无 |
| #105 [p3-01 r1] formatMs | closed `agent:ready` | 11-08T15:05 | 与 #106/#107 是同一任务的重复建单 | 由重跑 #126/#128/#130 覆盖（见下） | 已闭合 |
| #106 [p3-01 r2] | closed `agent:blocked` | 11-08T15:06 | 重复建单 | 同上 | 删 `agent:blocked` 标签 |
| #107 [p3-01 r3] | closed `agent:blocked` | 11-08T15:06 | 重复建单 | 同上 | 删 `agent:blocked` 标签 |

p3-01 的正身是 pass³ 演练：`ci/drills/pass3-issues-result.json` 记 3 轮共 36 次运行、36/36 通过、
`wilson95=[0.7575, 1]`、`merged: true`；三张演练单 #126/#128/#130 均为 `agent:done`。演练产物
（`ci/pass3/fmt-duration.mjs`）留在演练分支 `agent/issue-126/128/130`，不进主库 HEAD。

## 为什么会出现这个「阻塞」

1. `.logs/blocked-state.json` 的过期逻辑只有时间一条（`ci/blocked-recovery.mjs` 的 `pruneState`，
   retention 7 天）。工单被人工关闭后，条目仍会留满 7 天，期间看起来像「还在等池子」。
2. 11-08 的 pass³ 演练一次性建了 12 张 p3-01 副本（#103–#121 一带），关闭后留下 17 条本地记录，
   `recoverBlocked` 只认 GitHub 上 `state=open` 的 `agent:blocked`，于是日志里只剩「没有待处理任务」，
   而本地文件照旧躺着 —— 两条信息源分叉。
3. 关闭工单时没删 `agent:blocked` 标签，按标签检索会把 14 张已关闭单再次筛出来。

## 处置动作（可复核）

```
DELETE /repos/Satan1982/dsh-pipeline-demo/issues/{N}/labels/agent:blocked
  N ∈ 121,120,119,118,117,116,113,112,109,108,107,106,88,87   → 14×HTTP 200
GET issues?labels=agent:blocked&state=closed                    → 0
.logs/blocked-state.json                                        → {}（备份 D:\code\.tmp\blocked-state.backup-20261110.json）
bash scripts/verify.sh                                          → VERDICT: PASS
node ci/dispatch.mjs --status                                   → mode: ready, pause: false, 今日 ¥0.0000
```

## 口径

- **判断一张单要不要重投，只看 GitHub `state=open`**，`blocked-state.json` 只反映「调度器记得的退避计数」。
- 关闭 `agent:blocked` 工单时顺手删标签，否则历史残留会被下一次交接读成新任务。
- 不要为了这个改 `pruneState`：把「不在 open 列表就删」写进去会连 `requeues` 计数一起丢，
  而 `requeues` 是 `MAX_AUTO_REQUEUE=3` 的限流依据（`ci/dispatch.mjs:937`），删了会让失败单无限重投。
