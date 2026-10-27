# 集成验收：ledger

```bash
node --input-type=module -e "
import { addEntry, summarize } from './src/ledger.js';
let e = [];
e = addEntry(e, { date: '2026-10-01', amount: 100, note: '工资' });
e = addEntry(e, { date: '2026-10-02', amount: -30, note: '午饭' });
const s = summarize(e, '2026-10');
if (s.income !== 100 || s.expense !== 30 || s.balance !== 70) { console.log('VERDICT: FAIL', s); process.exit(1); }
const empty = summarize(e, '2025-01');
if (empty.income !== 0 || empty.expense !== 0 || empty.balance !== 0) { console.log('VERDICT: FAIL empty'); process.exit(1); }
console.log('VERDICT: PASS');
"
```
