# 任务分解：ledger

| 任务 | 说明 | 依赖 | 验收命令 |
|---|---|---|---|
| T1 | `src/ledger.js` 实现 `addEntry` / `summarize` 纯函数 | - | `node --input-type=module -e "import {addEntry,summarize} from './src/ledger.js'; const e=addEntry([],{date:'2026-10-01',amount:100,note:'工资'}); const s=summarize(e,'2026-10'); if(s.income!==100||s.expense!==0||s.balance!==100){console.log('VERDICT: FAIL');process.exit(1);} console.log('VERDICT: PASS')"` |
| T2a | `add` 子命令：把一条记录写进 JSON 文件（只做这一件事） | T1 | `node src/ledger-cli.js add --date 2026-10-01 --amount 100 --note salary --file /tmp/ledger-a.json && node --input-type=module -e "import {readFileSync} from 'node:fs';const d=JSON.parse(readFileSync('/tmp/ledger-a.json','utf8'));if(d.length!==1||d[0].amount!==100){console.log('VERDICT: FAIL',d);process.exit(1);}console.log('VERDICT: PASS');"` |
| T2b | `sum` 子命令：按月份汇总并打印余额 70 | T1, T2a | `node src/ledger-cli.js add --date 2026-10-01 --amount 100 --note salary --file /tmp/ledger-b.json && node src/ledger-cli.js add --date 2026-10-02 --amount -30 --note lunch --file /tmp/ledger-b.json && node src/ledger-cli.js sum --month 2026-10 --file /tmp/ledger-b.json | grep -q 70 && echo "VERDICT: PASS"` |
| T3 | 集成验收：跑 `scripts/integration.sh ledger` | T1,T2a,T2b | `bash scripts/integration.sh ledger` |
