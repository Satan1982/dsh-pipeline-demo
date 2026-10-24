#!/usr/bin/env node
// Assertion-content guard.
//
// The test-baseline.txt guard only counts tests and assertions, so
//   assert.equal(average([1, 2, 3]), 2)  ->  assert.equal(average([1, 2, 3]), 2.0)
// would slip through: same count, possibly different meaning.
//
// This guard fingerprints every assertion line (normalized whitespace + sha256) and
// keeps a multiset in scripts/assert-baseline.txt as `<count> <hash> <normalized line>`.
// Rules:
//   - every baseline fingerprint must still appear at least as many times  -> else FAIL
//   - brand new fingerprints are allowed, with a reminder to re-bless
//   - `--bless` rewrites the baseline file (a human decision, never automatic)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'scripts', 'assert-baseline.txt');
const SRC = path.join(ROOT, 'src');
const BLESS = process.argv.includes('--bless');
const baseArg = process.argv.indexOf('--baseline');
const BASELINE_OVERRIDE = baseArg >= 0 ? process.argv[baseArg + 1] : null;

function assertionLines() {
  const out = [];
  for (const f of readdirSync(SRC).filter((n) => n.endsWith('.test.js')).sort()) {
    const text = readFileSync(path.join(SRC, f), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('assert.')) continue;
      out.push(line.replace(/\s+/g, ' '));
    }
  }
  return out;
}

function fingerprint(line) {
  return createHash('sha256').update(line).digest('hex').slice(0, 16);
}

function multiset(lines) {
  const map = new Map();
  for (const line of lines) {
    const h = fingerprint(line);
    const cur = map.get(h) ?? { count: 0, line };
    cur.count += 1;
    map.set(h, cur);
  }
  return map;
}

function render(map) {
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([h, { count, line }]) => `${count} ${h} ${line}`)
    .join('\n') + '\n';
}

function parseBaseline(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+) ([0-9a-f]{16}) (.*)$/);
    if (!m) continue;
    map.set(m[2], { count: Number(m[1]), line: m[3] });
  }
  return map;
}

const current = multiset(assertionLines());

if (BLESS) {
  writeFileSync(BASELINE, render(current));
  let total = 0;
  for (const { count } of current.values()) total += count;
  console.log(`断言基线已写入：${current.size} 种、${total} 条`);
  process.exit(0);
}

let base;
try {
  base = parseBaseline(readFileSync(BASELINE_OVERRIDE ?? BASELINE, 'utf8'));
} catch {
  console.error(`缺少 ${path.relative(ROOT, BASELINE_OVERRIDE ?? BASELINE)}；首次建立基线请跑 bash scripts/verify.sh --bless`);
  process.exit(1);
}

const removed = [];
const added = [];
for (const [h, { count, line }] of base) {
  const now = current.get(h)?.count ?? 0;
  if (now < count) removed.push({ line, was: count, now });
}
for (const [h, { count, line }] of current) {
  const had = base.get(h)?.count ?? 0;
  if (count > had) added.push({ line, was: had, now: count });
}

if (removed.length) {
  console.error('拒绝：以下断言被删除或改写（内容指纹对不上）：');
  for (const r of removed) console.error(`  - ${r.line}  (基线 ${r.was} 次，现在 ${r.now} 次)`);
  console.error('如果确实要改断言，先修代码，再人工确认后跑 bash scripts/verify.sh --bless');
  process.exit(1);
}

if (added.length) {
  console.error('拒绝：以下断言是新增的，但基线没更新（新断言不在指纹保护范围内）：');
  for (const a of added) console.error(`  + ${a.line}  (基线 ${a.was} 次，现在 ${a.now} 次)`);
  console.error('新增断言后必须同 PR 跑 bash scripts/verify.sh --bless 提交基线，并在 PR 里说明新增了什么。');
  process.exit(1);
}
console.log(`断言基线持平：${current.size} 种`);
