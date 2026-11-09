# P4.5 变异探针落地记录（issue #235，2026-11-09）

> 结论：dispatch 生产主链现在有『测试真能失败』的检验。默认只扫描（0 次测试运行，warn 不拦）；
> 只有 issue 打 `mutation:strict` 才逐变异体跑受影响测试，存活即 BLOCKED(exit 3)。

## 1 问题

门禁只能回答「测试跑绿」。恒真断言（`assert.equal(true, true)`）、只走 happy path 的测试都能过。
`run.mjs` 的 P4.5 用变异探针回答另一半：把被测判据改坏，测试会不会红。生产主链（`ci/dispatch.mjs`）原本没有这一步（#229 P0–P7 对照表第 5 行）。

## 2 落点

| 文件 | 内容 |
| --- | --- |
| `ci/mutate.mjs`（新） | `parseAddedLines` / `mutateLine` / `planMutations` / `testPathFor` / `applyMutant` / `probeMutations` / `summarize` / `probeWorktree` + CLI（`--base/--head/--strict/--limit`） |
| `ci/mutate.test.mjs`（新） | 9 个单测：只变异新增行、测试文件不进探针、无可变异→warn、超时/缺测试的分类、漂移拒改、strict 拦截 |
| `ci/dispatch.mjs:1432-1456`（改） | 门禁绿之后、验收命令之前调用 `probeWorktree`；BLOCKED 时写失败指纹并中止 |
| `scripts/test-baseline.txt` / `scripts/assert-baseline.txt` | 同 PR bless：436→445 tests，1138→1192 asserts |

### 接线位置

1. `verifyWorktree` 门禁绿（`ci/dispatch.mjs:1404`）
2. **P4.5 变异探针**（`ci/dispatch.mjs:1432`）
3. 可执行验收命令（issue 的 `### 验收命令`）

放门禁之后是有意的：门禁已经绿了，变异体还活下来，说明「这条判据没有任何测试看着」，而不是代码本身坏了。

## 3 判定口径

| 情形 | 默认 | `mutation:strict` |
| --- | --- | --- |
| 新增行没有可注入的变异 | warn（放行，列出每一行及原因） | BLOCKED（exit 3） |
| 变异体被测试杀死 | PASS | PASS |
| 变异体存活 | 列出 `file:line op`，放行 | BLOCKED（exit 3） |
| 被测文件没有对应测试 | 记为 survived + 原因 | 同上 |
| 变异体把测试卡死/超时 | 记为 killed，原因写「卡死/超时」（不算存活） | 同上 |
| 工作树行内容与 diff 不一致 | 记为 skipped（diff 过期），不误报 | 同上 |

一行只产一个变异体（取第一个命中的算子，确定性优先）。算子：`>=`→`>`、`<=`→`<`、`===`→`!==`、`&&`→`||`、`||`→`&&`、常量 0/1、`true`→`false`。
测试文件按 `ci/review.mjs` 的口径排除：`/^(?:src|ci)\/.*\.test\.(?:js|mjs)$/`。上限 40 个变异体/单。

## 4 真实落地记录（本次 PR 自身 diff：`origin/main..HEAD`）

| 指标 | 值 |
| --- | --- |
| 新增行 | 516 |
| 变异体 | 47 |
| 跳过（测试文件/注释/非代码/无算子） | 469 |
| killed | 21 |
| survived | 26 |

按文件：`ci/mutate.mjs` 43 个（killed 21 / survived 22），`ci/dispatch.mjs` 4 个（全部 survived）。

### 存活清单与原因

- `ci/mutate.mjs:35-43`（6 个）：变异的是**算子表/跳过规则表本身**（正则与常量）。把它们改坏不会改变已有测试的行为——这些行是探针的配置数据，不是判据。
- `ci/mutate.mjs:135-191`（8 个）：`probeMutations/summarize` 的边界分支（limit 截断、越界、`why` 文案）。单测覆盖了主路径，边界值没逐个断言。
- `ci/mutate.mjs:229-266`（8 个）：CLI 主程序块（`--strict` 判据、参数解析）。单测直接调导出函数，没走 CLI。
- `ci/dispatch.mjs:1435/1442/1443/1448`（4 个）：dispatch 的接线行（diff 参数、`=== null`、`||`、`existsSync` 判空）。`dispatch.mjs` 是 CLI 脚本、不可导入，接线行没有单测——**已知缺口**，判定语义都在 `mutate.mjs` 里且有单测。

这 26 个存活说明探针工作正常（它确实能指出没人看着的判据），也说明本 PR 自己在 `mutation:strict` 下会被拦。-
- 本工单未打 `mutation:strict`（默认路径），所以不拦。后续要把存活清单清零，最值得补的是 CLI 块与 dispatch 接线的测试。

## 5 成本

- 默认路径：只跑 `git diff` + 文本扫描，**0 次测试运行**（入口改动多是文档/配置，BLOCKED 会大面积误伤）。
- `mutation:strict`：每个变异体 1 次 `node --test <同目录同名 .test>`（`timeout 300s`），上限 40 个/单。
- 变异体写进工作树后 `finally` 必定还原；进程被杀中断最多留一个脏文件，`git checkout -- <file>` 可恢复。

## 6 验证命令与输出

```bash
# 单测
node --test ci/mutate.test.mjs
# -> tests 9 / pass 9 / fail 0

# 门禁
bash scripts/verify.sh
# -> VERDICT: PASS（tests 445 / asserts 1192）

# 手工复算（在 worktree 里，对 base...HEAD 的 diff 跑探针）
node ci/mutate.mjs --base origin/main --head HEAD --strict
# -> BLOCKED: 变异体 47 个（跑 47）：killed=21 survived=26 ...（本 PR 默认路径不受影响）
```

## 7 已知限制

- 文本级算子，不是 AST：跨行表达式、多行链式调用不产变异体（`planMutations.skipped` 会写明原因）。
- 只支持同目录同名 `.test.mjs` 约定；其他测试布局记 `missingTest`。
- `dispatch.mjs` 不可导入，接线行无单测（见 §4 存活清单）。
- 变异体上限 40：超出部分不跑并在输出里写「超过上限」。
