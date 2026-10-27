# 契约：ledger

| 函数 | 输入 | 输出 | 异常 |
|---|---|---|---|
| `addEntry(entries, entry)` | `entries: Entry[]`、`entry: {date, amount, note}` | 新数组（不改原数组） | `TypeError`（金额非数字 / 日期格式不对） |
| `summarize(entries, ym)` | `entries: Entry[]`、`ym: 'YYYY-MM'` | `{income, expense, balance}` | `TypeError`（ym 格式不对） |

约定：`income` 与 `expense` 都取正数（`expense` 是绝对值），`balance = income - expense`。
