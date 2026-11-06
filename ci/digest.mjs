#!/usr/bin/env node
// 每天早上的事件摘要：events.jsonl 是机器可读的，但没人每天去 tail 它。
// 这个 CLI 把过去 N 天的事件按类聚合并打印成一段 markdown；没有事件也要正常退出 0
// （计划任务每天跑，空跑不是失败）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EVENT_KINDS } from './notify.mjs';
import { defaultEventsFile } from './event.mjs';

export function parseEvents(text) {
  const records = [];
  let bad = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && rec.kind) records.push(rec);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { records, bad };
}

export function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function summarize(records, { sinceMs = Date.now() - 24 * 3600 * 1000 } = {}) {
  const kept = (records ?? []).filter((r) => {
    const t = new Date(r.at).getTime();
    return Number.isNaN(t) || t >= sinceMs;
  });
  const byKind = {};
  for (const r of kept) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const byDay = {};
  for (const r of kept) {
    const d = localDay(r.at);
    byDay[d] = (byDay[d] ?? 0) + 1;
  }
  return { kept, byKind, byDay };
}

export function renderMarkdown({ kept, byKind, bad = 0 }, { now = new Date(), days = 1 } = {}) {
  const lines = [`## 流水线事件 · 近 ${days} 天`, '', `生成时间：${now.toISOString()}`, ''];
  if (!kept.length) {
    lines.push('（没有事件）');
    return lines.join('\n');
  }
  lines.push('| 类别 | 数量 | 含义 |', '|---|---|---|');
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${kind} | ${n} | ${EVENT_KINDS[kind] ?? '未登记'} |`);
  }
  lines.push('', '最近的记录：');
  for (const r of kept.slice(-10).reverse()) {
    lines.push(`- ${r.at} · ${r.kind}${r.issue ? ` · #${r.issue}` : ''}${r.why ? ` · ${r.why}` : ''}`);
  }
  if (bad) lines.push('', `⚠ ${bad} 行无法解析（已跳过，不影响其余记录）`);
  return lines.join('\n');
}

const USAGE = '用法：node ci/digest.mjs [--days 1] [--file events.jsonl] [--json]';

export function parseArgs(argv) {
  const opt = { days: 1, file: defaultEventsFile(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days') opt.days = Number(argv[++i]);
    else if (a === '--file') opt.file = argv[++i];
    else if (a === '--json') opt.json = true;
    else if (a === '--help' || a === '-h') opt.help = true;
    else return { error: `未知参数：${a}` };
  }
  return { opt };
}

export function runCli(argv, { out = console.log, err = console.error, now = new Date() } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    err(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const { opt } = parsed;
  if (opt.help) {
    out(USAGE);
    return 0;
  }
  const days = Number.isFinite(opt.days) && opt.days > 0 ? opt.days : 1;
  let text = '';
  if (existsSync(opt.file)) text = readFileSync(opt.file, 'utf8');
  const { records, bad } = parseEvents(text);
  const summary = summarize(records, { sinceMs: now.getTime() - days * 24 * 3600 * 1000 });
  if (opt.json) out(JSON.stringify({ ...summary, bad }, null, 2));
  else out(renderMarkdown({ ...summary, bad }, { now, days }));
  return 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) process.exitCode = runCli(process.argv.slice(2));
