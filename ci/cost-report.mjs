#!/usr/bin/env node
// 把 .logs/usage.jsonl 汇成 docs/cost-report.md：按天汇总花费、按单列最贵的几单。
// 数据来自调度器每次 headless 结束时写的记录（免费档 cny=0，付费档按官方价目表估算）。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USAGE = process.env.DSH_USAGE_LOG || path.join(ROOT, '.logs', 'usage.jsonl');
const OUT = process.env.DSH_COST_REPORT || path.join(ROOT, 'docs', 'cost-report.md');

export function bjDate(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '未知';
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function summarize(lines, now = new Date()) {
  const rows = [];
  for (const line of lines) {
    const s = String(line).trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      rows.push({
        date: bjDate(e.at),
        issue: e.issue,
        attempt: e.attempt,
        model: e.model,
        paid: !!e.paid,
        cny: Number(e.cny || 0),
        total: Number(e.totalTokens || 0),
      });
    } catch { /* 半行坏行跳过 */ }
  }
  const byDay = new Map();
  for (const r of rows) {
    const d = byDay.get(r.date) || { date: r.date, runs: 0, free: 0, paid: 0, cny: 0, tokens: 0 };
    d.runs += 1;
    d.tokens += r.total;
    d.cny += r.cny;
    if (r.paid) d.paid += 1; else d.free += 1;
    byDay.set(r.date, d);
  }
  const days = [...byDay.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  const expensive = [...rows].sort((a, b) => b.cny - a.cny).slice(0, 5);
  const today = bjDate(now.toISOString());
  return {
    rows, days, expensive,
    today, todayCny: days.find((d) => d.date === today)?.cny ?? 0,
    totalCny: rows.reduce((s, r) => s + r.cny, 0),
    runs: rows.length,
  };
}

export function render(sum) {
  const NL = String.fromCharCode(10);
  const y = (v) => (v === 0 ? '¥0' : `¥${Number(v).toFixed(v < 0.01 ? 4 : 2)}`);
  const out = [
    '# 成本报表', '',
    `> 自动生成，数据源 .logs/usage.jsonl（每次 headless 一条）。免费档按 ¥0 记，付费档按 DeepSeek 官方价目表估算。`,
    `> 缓存命中量 DSH 没有透出，输入一律按「未命中」计 —— 金额偏高，是保守估计。`, '',
    `- 运行次数：${sum.runs}`,
    `- 累计估算：${y(sum.totalCny)}`,
    `- 今日（${sum.today}）：${y(sum.todayCny)}`, '',
    '## 按天', '',
    '| 日期 | 运行 | 免费 | 付费 | tokens | 估算花费 |',
    '|---|---|---|---|---|---|',
    ...sum.days.map((d) => `| ${d.date} | ${d.runs} | ${d.free} | ${d.paid} | ${d.tokens} | ${y(d.cny)} |`),
    '', '## 最贵的几单', '',
    '| 工单 | 尝试 | 模型 | tokens | 估算 |',
    '|---|---|---|---|---|',
    ...sum.expensive.map((r) => `| #${r.issue} | ${r.attempt} | ${r.model} | ${r.total} | ${y(r.cny)} |`),
    '',
  ];
  return out.join(NL);
}

function main() {
  if (!existsSync(USAGE)) {
    console.error(`没有 ${USAGE}：还没有任务跑过，或用 DSH_USAGE_LOG 指定。`);
    process.exit(0);
  }
  const sum = summarize(readFileSync(USAGE, 'utf8').split('\n'));
  const md = render(sum);
  writeFileSync(OUT, md);
  console.log(`成本报表已写入 ${OUT}：${sum.runs} 次运行，累计 ¥${sum.totalCny.toFixed(4)}，今日 ¥${sum.todayCny.toFixed(4)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].split(String.fromCharCode(92)).join('/')}`).href) main();
