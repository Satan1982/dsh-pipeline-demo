# 设计：记账小工具

## 模块划分

| 模块 | 职责 | 依赖 |
|---|---|---|
| `src/ledger.js` | 记录与汇总的纯函数 | 无 |
| `src/ledger-cli.js` | 解析命令行参数、读写数据文件 | `src/ledger.js` |

## 数据模型

```json
{"entries":[{"date":"2026-10-27","amount":-30,"note":"午饭"}]}
```

`amount` 正数为收入、负数为支出；`date` 用 `YYYY-MM-DD`。

## 接口契约

见 `contracts/ledger-contract.md`：`addEntry(entries, {date, amount, note})`、`summarize(entries, 'YYYY-MM')`。

## 失败处理

- 金额不是数字 → 抛 `TypeError`；
- 数据文件不存在 → 当成空账本，不报错；
- 日期格式不对 → 抛 `TypeError`。

## 非功能要求

零依赖；单次操作 < 50ms；数据文件用 UTF-8。

## 取舍记录

- 选 JSON 文件不选 SQLite：演示项目，避免原生依赖。
