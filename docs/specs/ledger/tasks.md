# 任务分解：ledger

| 任务 | 说明 | 依赖 | 验收命令 |
|---|---|---|---|
| T1 | `src/ledger.js` 实现 `addEntry` / `summarize` 纯函数 | - | `node --input-type=module -e "import {addEntry,summarize} from './src/ledger.js'; const e=addEntry([],{date:'2026-10-01',amount:100,note:'工资'}); const s=summarize(e,'2026-10'); if(s.income!==100||s.expense!==0||s.balance!==100){console.log('VERDICT: FAIL');process.exit(1);} console.log('VERDICT: PASS')"` |
| T2 | `src/ledger-cli.js` 命令行：`add` / `sum` 两个子命令 | T1 | `node --input-type=module -e "import {summarize} from './src/ledger.js'; const s=summarize([], '2026-10'); if(s.balance!==0){console.log('VERDICT: FAIL');process.exit(1);} console.log('VERDICT: PASS')"` |
| T3 | 集成验收：跑 `scripts/integration.sh ledger` | T1,T2 | `bash scripts/integration.sh ledger` |
