# 使用手册（2026-10-28）

面向「我要让它替我干活」的人。架构与设计理由见 [`design-2026-10-28.md`](design-2026-10-28.md)。

---

## 0. 30 秒上手

```bash
cd /d/code/dsh-pipeline-demo
node ci/dispatch.mjs --once        # 先手工跑一轮，看清管道通不通
node ci/dispatch.mjs --ensure      # 通了就让它在后台常驻
bash ci/watch.sh 60 '领取|没有待处理'  # 看它在干什么
```

然后在 GitHub 上按 `自动化任务` 模板开一张 issue —— 它会自己开始跑。

---

## 1. 前置检查（三条命令）

```bash
node -v                     # 没有就在 PATH 里补随包 node（见 AGENTS.md）
ls ../.secrets/github-token.txt   # 只看有没有，别 cat 内容；调度器自己读
"C:/Program Files/Git/cmd/git.exe" --version   # 必须用系统 git，ucrt64 那个连不上 GitHub
```

- token 缺失时调度器会直接报错退出，不会静默卡住。
- 不需要装 `gh`、`npm`；门禁自己会退到 pnpm。

---

## 2. 写一张工单（最关键的一步）

GitHub → New issue → 模板 **自动化任务**（`.github/ISSUE_TEMPLATE/agent-task.yml`，自动打 `agent:ready`）。

| 字段 | 必填 | 怎么写 |
|---|---|---|
| 目标 | ✅ | 一段话说清「改成什么样」。别写「优化一下」，写「`divide(a,b)` b=0 抛 `RangeError`」 |
| 验收标准 | ✅ | 人话 + 可断言的点。agent 照着自测 |
| **验收命令** | 强烈建议 | shell 命令，调度器**自己**跑，全 exit 0 才允许开 PR。这是唯一 agent 改不动的判据 |
| 约束 | 可选 | 不许碰的文件、不许加的依赖、不许改的接口 |

验收命令可以写成：

```bash
node -e "import('./src/index.js').then(m=>{ if(m.divide(6,3)!==2) process.exit(1); })"
bash scripts/verify.sh
```

想让它输出裁决，最后一行打 `VERDICT: PASS` / `VERDICT: FAIL <原因>`；工单带 `verdict:strict` 时缺这行直接算失败。
**验收命令留空** = 只靠门禁 + 语义评审，等于把「做没做到」的判断交回给模型，不建议。

好工单 vs 坏工单：

- ✅ 「在 `src/stats.js` 加 `median(xs)`，空数组返回 `null`；验收命令 `node -e "...test..."`；不改 `mean`」
- ❌ 「优化统计模块」「按最佳实践重构」「修一下那个 bug」

---

## 3. 启动 / 停止

```bash
node ci/dispatch.mjs --once      # 跑一轮就退出（本地验证、计划任务都用它）
node ci/dispatch.mjs --ensure    # 保证有常驻：有就报 pid，没有就脱离父进程拉起一个
node ci/dispatch.mjs --dry-run   # 只列待办 + 打印会做什么，不改任何东西（标签/dry 恢复都只打印）
node ci/dispatch.mjs --serve     # 前台常驻（调试用，Ctrl+C 停）
```

开机自启与兜底（opt-in）：

```powershell
powershell -ExecutionPolicy Bypass -File ci\install-autostart.ps1   # 登录自启（HKCU Run）
powershell -ExecutionPolicy Bypass -File ci\install-task.ps1        # 计划任务每 5 分钟 --once 敲门
powershell -ExecutionPolicy Bypass -File ci\install-task.ps1 -Remove
```

**停**：关掉计划任务 + 杀掉常驻（pid 在 `.logs/dispatch.lock`）：

```powershell
Get-Content .logs\dispatch.lock          # {"pid":...,"at":...}
Stop-Process -Id <pid>
```

---

## 4. 命令速查

| 命令 | 干什么 | 备注 |
|---|---|---|
| `bash scripts/verify.sh` | 跑门禁六步 | 唯一门禁入口 |
| `bash scripts/verify.sh --bless` | 改了测试/断言后同步基线 | 必须和代码同一次提交 |
| `bash ci/land.sh "短句说明"` | 门禁 → 提交 → 推 https/SSH → 镜像 Gitee | 不许分开手跑；`DSH_LAND_PUSH=0` 只提交；默认只收已跟踪文件的改动，新增文件要 `DSH_LAND_ALL=1` |
| `bash ci/watch.sh 300 '关键词'` | 等 5 分钟再打日志尾部 | 比反复 tail 省钱；可丢后台 |
| `node ci/plan.mjs <slug> --graph` | 看规格的依赖分层 | `--dry` 预览建单，`--create` 真建 |
| `node ci/dispatch.mjs --dry-run` | 只列待办 | 一轮就退出 |
| `node ci/dispatch.mjs --probe-stale` | 探活免费池里 stale/unknown 的模型 | 手动跑，不进轮询；`DSH_PROBE_LIMIT`（默认 8）控制个数 |
| `node ci/dispatch.mjs --repos repos.json` | 同账号多库：每库起一个独立常驻 | 每库独立 `.logs` / `.worktrees` / 锁；清单写 `[{"repo":"owner/name","dir":"D:/code/x"}]` |
| `node ci/distill-failures.mjs` | 失败库蒸馏进 Hindsight | 每天自动也会跑 |
| `node ci/cost-report.mjs` | 生成 `.logs/cost-report.md` | 看钱花在哪；别再写进 `docs/`（会脏工作树） |
| `python ~/.dsh/tools/free-models/fm.py stats --json` | 免费池健康快照 | 判断该不该重投 |

---

## 5. 标签手册

| 标签 | 谁打 | 含义 |
|---|---|---|
| `agent:ready` | 人（模板自动） | 待领取 |
| `agent:working` | 调度器 | 正在跑；孤儿会被自动清理 |
| `agent:done` | 调度器 | 已完成并入 |
| `agent:failed` | 调度器 | 重试耗尽；修完去掉它重新打 `agent:ready` |
| `agent:blocked` | 调度器 | 环境问题挂起（免费池不可用）。**通常不用管，会自动重投** |
| `agent:blocked:manual` | 调度器 | 自动重投 3 次用完，需要人接手 |
| `model:strong` | 人 | 直接用强模型（跳过弱模型试跑） |
| `model:paid` | 人 | 允许这张单花钱（`deepseek-flash`） |
| `merge:auto` | 人 | CI 绿就自动 squash 合并关单 |
| `dep-on:T1` | `plan.mjs` | 等 T1 关闭才开工 |
| `allow:gate` | 人 | 允许改门禁脚本 / `ci/*` |
| `readonly:ok` | 人 | 只读调查单（不许写文件） |
| `acceptance:optional` | 人 | 免验收命令 |
| `verdict:strict` | 人 | 缺 `VERDICT:` 直接失败 |

> 标签由**调度器启动时自动补齐**（清单在 `ci/labels.mjs`，`ensureLabels()` 拿锁后跑一次，日志 `[labels] 补齐 N 个缺失标签：…`）——新建仓库不用手动建。下面这段留作「不想等调度器，或想在别的仓库先建好」时用。
>
> 为什么要有这一步：GitHub 打不存在的标签不会报错，而是静默丢弃（2026-10-28 实测：`agent:blocked:manual` 当时没建，自动恢复的「交给人」分支就少了这个标记）。`dep-on:<任务号>` 不在自动补齐范围（名字随任务号变），需要时自己加。
>
> ```bash
> for L in agent:ready agent:working agent:done agent:failed agent:blocked agent:blocked:manual \
>          model:strong model:paid merge:auto allow:gate readonly:ok acceptance:optional verdict:strict; do
>   curl -s -X POST -H "Authorization: Bearer $TOK" -H 'Accept: application/vnd.github+json' \
>     https://api.github.com/repos/<owner>/<repo>/labels -d "{\"name\":\"$L\",\"color\":\"ededed\"}" > /dev/null
> done
> ```

---

## 6. 日常巡检（每天 2 分钟）

```bash
tail -40 .logs/dispatch.log                     # 在干什么
grep -c '领取' .logs/dispatch.log               # 今天领了几张
tail -5 docs/failures.jsonl                     # 最近失败都长什么样
cat .logs/cost-report.md                        # 花了多少（每日自动刷新）
tail -20 ~/.dsh/coord/log/events.jsonl          # 需要人知道的事（失败/要接手/花费到顶）
```

看这几个关键词就够了：

| 日志片段 | 意思 | 要做什么 |
|---|---|---|
| `没有待处理任务` | 空闲 | 无 |
| `[issue #N] 领取` | 开工了 | 无 |
| `[issue #N] 免费池不可用` | 挂起 | 通常在等自动恢复，看下面 `[blocked]` |
| `[blocked] #N …自动重投 agent:ready（第 1/3 次）` | 自愈成功 | 无 |
| `[blocked] #N …停止自动恢复` | 重投 3 次用完 | 人去修单子 |
| `接管陈旧锁` / `锁已被接管…常驻进程退出` | 两个实例撞了，正常让位 | 无 |
| `[dep] #N 在等 T1 关闭` | 依赖没完成 | 无 |
| `[notify] 已发系统通知：…` | 弹了 Windows 通知 | 看一眼是什么事 |

---

## 7. 故障处置

| 现象 | 判读 | 动作 |
|---|---|---|
| 好久没动静 | `.logs/dispatch.lock` 的 pid 还活着吗 | 死了就 `--ensure`；活着但日志不刷心跳，`Stop-Process` 后 `--ensure` |
| 日志一直 `没有待处理任务` 但 issue 是 ready | 标签没打对 / 依赖没完成 / 日预算已满 | 看 issue 标签与 `[dep]`、`[cost]` 日志 |
| 单子反复 `agent:blocked` | 免费池长期不可用 | 看 `fm.py stats --json`；急就 `model:paid` + `agent:ready` |
| `agent:blocked:manual` | 自动重投用完 | 看该单最后一次失败评论，判断是池子容量还是任务本身写不过 |
| CI 红但本地绿 | 跑的是 base 分支的断言基线 | 门禁对 base 跑 `--allow-additions`；本地 `--bless` 后同 PR 提交 |
| `assert guard` / `test guard` 红 | 改了断言或测试数没 bless | `bash scripts/verify.sh --bless` |
| PR 冲突 | `rebaseAgentBranch` 会自动 rebase；基线文件冲突自动重算 | 源码冲突才需人看 |
| agent 说做完了但 diff 是空的 | 失败指纹 `agent-no-change` | 重写工单：目标太模糊 |
| 任务超时 | 单任务默认 30 分钟（`DSH_TASK_TIMEOUT_MS`） | 拆小，或调大超时 |

---

## 8. 成本

- 每单 token 用量写 `.logs/usage.jsonl`，按官方价折人民币（免费池记 ¥0）。
- 闸门：单任务 > `DSH_TASK_MAX_CNY`（0.5 元）告警并暂停本批；单日 > `DSH_DAY_MAX_CNY`（5 元）当天不再领取。
- 高峰（工作日 9:00–12:00、14:00–18:00）单价翻倍 → 大批量任务尽量错峰。
- 免费池选型：`python ~/.dsh/tools/free-models/fm.py pick --kind chat --max-ms 4000 --json`，用完 `report` 回报。

### 8.1 用哪个模型、在哪改（DSH 设置里没有这个开关）

**先说结论**：DSH 设置界面里**没有**「子代理 / headless 用哪个模型」这一项（2026-10-28 核对过）。主会话的模型由设置决定，子代理跟随主会话；而**流水线跑任务时挂的模型，是 `--patch` 文件说了算**，三个文件对应三档：

| 档 | 文件（默认路径，env 可覆盖） | 谁在用 |
|---|---|---|
| 弱档（省） | `D:\code\.secrets\headless-model.yml`（`ci/headless-task.sh:22` 默认值；env `DSH_HEADLESS_PATCH`） | 默认试跑：headless 编码、单文件小改 |
| 强档 | `.secrets/headless-model-free-strong.yml`，或每轮按免费池健康生成的 `.logs/headless-model-free-strong.generated.yml`（env `DSH_HEADLESS_STRONG_PATCH` 一设就不再生成） | 工单带 `model:strong`、失败重试升级、冲突解决 |
| 付费档 | `.secrets/headless-model-paid.yml`（env `DSH_HEADLESS_PAID_PATCH`） | 免费池不可用且人明确打了 `model:paid` |

- 想「子代理用便宜模型」= 改**弱档 patch 文件**（里面就是 `- id: ... / providers: ... / models: - id: ...` 的 DSH patch 结构），不是去设置里找开关。
- 只改弱档、不动强档：省钱的活走弱档，卡住了自动升级到强档重试，语义评审另有自己的模型选择（`docs/model-policy.md` §2）。
- 每次使用前先 `python ~/.dsh/tools/free-models/fm.py stats --json` 看池子状态；`down` 的模型不要写进 patch。
- 改完 patch 不用重启调度器：`ci/headless-task.sh` 每次起任务时读文件，下一张单就生效。

---

## 9. 从一张单到一个系统

单文件小改用 issue 就够。一个系统（多模块、跨文件、要并行）先写规格：

```bash
cp -r docs/specs/_template docs/specs/<slug>     # spec / design / tasks / integration
# 填 tasks.md 的表格：任务 / 说明 / 依赖 / 验收命令
node ci/plan.mjs <slug> --graph                  # 看依赖分层
node ci/plan.mjs <slug> --dry                    # 预览会建哪些单
node ci/plan.mjs <slug> --create                 # 真建（依赖变成 dep-on:Tn）
bash scripts/integration.sh <slug>               # 跨切片验收
```

现成样例：`docs/specs/ledger/`（记账小工具，T1→T2a/T2b→T3，实测 #76~#84 全部合并）。

---

## 10. 什么时候别用它

- **需求本身没想清楚**：它会非常忠实地做错事，还做得很快。
- **验收不可执行**：没有命令能判对错的任务（「界面好看点」），语义评审只能给主观意见。
- **要改门禁 / 发版 / 动已推送历史**：红线，必须人来做。
- **只需要一次、十分钟能自己敲完的改动**：写工单的成本比改代码高。
