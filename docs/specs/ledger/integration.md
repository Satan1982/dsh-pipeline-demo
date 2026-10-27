# 集成验收：ledger

## 纯函数契约（T1）

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

## 命令行端到端（T1 + T2a + T2b）

按 spec.md 的验收场景跑真实 CLI：记收入、记支出、查不存在的月份，并核对落盘的 JSON 数据模型。

```bash
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
book="$tmp/ledger.json"

node src/ledger-cli.js add --date 2026-10-01 --amount 100 --note 工资 --file "$book"
node src/ledger-cli.js add --date 2026-10-02 --amount -30 --note 午饭 --file "$book"

got=$(node src/ledger-cli.js sum --month 2026-10 --file "$book")
[ "$got" = "income=100 expense=30 balance=70" ] || { echo "VERDICT: FAIL 当月汇总: $got"; exit 1; }

empty=$(node src/ledger-cli.js sum --month 2025-01 --file "$book")
[ "$empty" = "income=0 expense=0 balance=0" ] || { echo "VERDICT: FAIL 空月份: $empty"; exit 1; }

missing=$(node src/ledger-cli.js sum --month 2026-10 --file "$tmp/missing.json")
[ "$missing" = "income=0 expense=0 balance=0" ] || { echo "VERDICT: FAIL 缺文件: $missing"; exit 1; }

node --input-type=module -e "
import { readFileSync } from 'node:fs';
const entries = JSON.parse(readFileSync(process.argv[1], 'utf8'));
if (!Array.isArray(entries) || entries.length !== 2) { console.log('VERDICT: FAIL 数据文件', entries); process.exit(1); }
if (entries[0].date !== '2026-10-01' || entries[0].amount !== 100) { console.log('VERDICT: FAIL 第一条', entries[0]); process.exit(1); }
if (entries[1].date !== '2026-10-02' || entries[1].amount !== -30) { console.log('VERDICT: FAIL 第二条', entries[1]); process.exit(1); }
" "$book"

echo "VERDICT: PASS"
```
