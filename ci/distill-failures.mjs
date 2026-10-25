#!/usr/bin/env node
// 把 docs/failures.jsonl 里的失败指纹蒸馏成一份摘要，写进 Hindsight 记忆库。
//
// 为什么需要它：指纹库只在「本机这个仓库」里滚，换一台机器、换一个仓库就重新踩同样的坑。
// Hindsight 是三台机器共享的长期记忆，把它当成跨机器的「踩坑知识」落点。
//
// 用法：
//   node ci/distill-failures.mjs            # 打印摘要并写入 Hindsight
//   node ci/distill-failures.mjs --dry      # 只打印，不写
//   node ci/distill-failures.mjs --top 20   # 多取几条
//   node ci/distill-failures.mjs --bank coding-agent::code
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORE = process.env.DSH_FAILURES_STORE || path.join(ROOT, 'docs/failures.jsonl');
const CLIENT = process.env.DSH_HINDSIGHT_CLIENT || path.join(homedir(), '.hindsight/coding-agent.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const pickFlag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const TOP = Number(pickFlag('--top', 12));

export function readStore(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function group(records) {
  const byFp = new Map();
  for (const r of records) {
    const fp = r.fp || 'unknown';
    const cur = byFp.get(fp) || { fp, count: 0, reason: '', issues: new Set(), fix: '', last: '' };
    cur.count += 1;
    if (r.reason) cur.reason = r.reason;
    if (r.fix) cur.fix = r.fix;
    if (r.issue) cur.issues.add(r.issue);
    if (r.at && r.at > cur.last) cur.last = r.at;
    byFp.set(fp, cur);
  }
  return [...byFp.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
}

// 记录里带着调用栈（`at runTask (file:///D:/...)`），对人类没信息量还夹着本机路径，
// 摘要把它们剪掉，只留第一句现象。
export function clean(text, max = 300) {
  const kept = String(text || '')
    .split('\n')
    .filter((line) => !/^\s+at\s/.test(line) && !line.includes('node:internal'));
  return kept.join(' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function render(groups) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# 自动化编程流水线 · 失败指纹摘要（${today}）`,
    '',
    '来源：dsh-pipeline-demo 的 docs/failures.jsonl（调度器每次失败都会记一条，按根因归并）。',
    '用途：换机器/换仓库时先查这里，别重新踩。',
    '',
    `共 ${groups.length} 个根因，取出现次数最多的 ${Math.min(TOP, groups.length)} 条：`,
    '',
  ];
  for (const g of groups.slice(0, TOP)) {
    lines.push(`## ${g.count} 次 · 指纹 ${g.fp}`);
    lines.push(`- 现象：${clean(g.reason) || '（未记录原因）'}`);
    if (g.fix) lines.push(`- 修法：${clean(g.fix)}`);
    if (g.issues.size) lines.push(`- 相关工单：${[...g.issues].map((n) => `#${n}`).join(' ')}`);
    lines.push(`- 最近一次：${g.last || '未知'}`);
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

async function post(text, bank) {
  const cfg = JSON.parse(readFileSync(CLIENT, 'utf8'));
  const url = `${cfg.apiUrl.replace(/\/$/, '')}/v1/default/banks/${encodeURIComponent(bank)}/memories`;
  const body = {
    items: [{ content: text, context: 'pipeline-failures', tags: ['pipeline', 'failures'] }],
    async: true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiToken}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, body: raw.slice(0, 300) };
}

async function main() {
  const records = readStore(STORE);
  if (!records.length) {
    console.error(`[distill] ${STORE} 里没有记录，无事可做。`);
    process.exit(0);
  }
  const text = render(group(records));
  console.log(text);

  if (DRY) {
    console.error('[distill] --dry：只打印，没有写入 Hindsight。');
    process.exit(0);
  }
  const cfg = JSON.parse(readFileSync(CLIENT, 'utf8'));
  // 默认写独立 bank：踩坑知识跨仓库通用，混进某个仓库的 coding bank 反而不好检索。
  const bank = pickFlag('--bank', process.env.DSH_HINDSIGHT_BANK || 'pipeline::failures');
  if (!FORCE && !bank) {
    console.error('[distill] 没有 bank（cod-agent.json 里也没有 bankId），用 --bank 指定。');
    process.exit(1);
  }
  const r = await post(text, bank);
  if (r.status >= 200 && r.status < 300) {
    console.log(`[distill] 已写入 Hindsight：bank=${bank} status=${r.status}`);
  } else {
    console.error(`[distill] 写入失败：status=${r.status} ${r.body}`);
    process.exit(1);
  }

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
