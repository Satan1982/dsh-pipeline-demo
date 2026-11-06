// 评审裁决台账：一行一次尝试，落本机（~/.dsh/coord/log），不进仓库、不碰 .dshwolf。
//
// 为什么单独一份：events.jsonl 只记「需要人知道」的异常，usage.jsonl 只有 token/成本；
// 「这单验收怎么判的、语义评审什么结论」没有单一落点，事后只能翻 .logs 里几千个文件。
// 这里只追加，不改任何既有日志，也不替代 .dshwolf/AUTO-MODE.md（那是策略文件，不是台账）。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function defaultLedgerFile() {
  return process.env.DSH_LEDGER_LOG || path.join(homedir(), '.dsh', 'coord', 'log', 'auto-ledger.jsonl');
}

export function ledgerEntry({
  at, issue, attempt = 1, acceptance = 'none', acceptanceVerdict = 'none',
  semantic = 'unknown', files = 0, cny = null, outcome = 'reviewed',
} = {}) {
  const rec = {
    at: at ?? new Date().toISOString(),
    issue: Number(issue),
    attempt: Number(attempt) || 1,
    acceptance: String(acceptance),
    acceptanceVerdict: String(acceptanceVerdict),
    semantic: String(semantic),
    files: Number(files) || 0,
    outcome: String(outcome),
  };
  if (cny !== null && Number.isFinite(Number(cny))) rec.cny = Number(cny);
  return rec;
}

export function appendLedger(file, entry) {
  const target = file || defaultLedgerFile();
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
  return target;
}

export function readLedger(file) {
  const target = file || defaultLedgerFile();
  if (!existsSync(target)) return { records: [], bad: 0 };
  const records = [];
  let bad = 0;
  for (const line of readFileSync(target, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { records, bad };
}

export function renderMarkdown({ records, bad = 0 } = {}) {
  const lines = ['| 时间 | 工单 | 验收 | 语义 | 文件 | 成本 |', '|---|---|---|---|---|---|'];
  for (const r of records ?? []) {
    lines.push(`| ${r.at} | #${r.issue} | ${r.acceptanceVerdict} | ${r.semantic} | ${r.files} | ${r.cny === undefined ? '-' : `¥${r.cny.toFixed(3)}`} |`);
  }
  if (!records?.length) lines.push('| （没有记录） | | | | | |');
  if (bad) lines.push('', `⚠ ${bad} 行无法解析（已跳过）`);
  return lines.join('\n');
}

const USAGE = '用法：node ci/ledger.mjs [--file auto-ledger.jsonl] [--md]';

export function runCli(argv, { out = console.log, err = console.error } = {}) {
  let file = defaultLedgerFile();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--file') file = argv[++i];
    else if (a === '--md') { /* 默认就是 markdown */ }
    else if (a === '--help' || a === '-h') { out(USAGE); return 0; }
    else { err(`${a} 未知\n${USAGE}`); return 2; }
  }
  const side = readLedger(file);
  out(renderMarkdown(side));
  return 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) process.exitCode = runCli(process.argv.slice(2));
