// 台账的回归测试：追加可重读、坏行跳过、渲染列齐全。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendLedger, ledgerEntry, readLedger, renderMarkdown, runCli } from './ledger.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ledger-'));

test('entry 只留固定列，缺省值稳定', () => {
  const e = ledgerEntry({ issue: 9, acceptanceVerdict: 'pass', semantic: 'ok', files: 3, cny: 0.12 });
  assert.deepEqual(Object.keys(e), ['at', 'issue', 'attempt', 'acceptance', 'acceptanceVerdict', 'semantic', 'files', 'outcome', 'cny']);
  assert.equal(e.attempt, 1);
  assert.equal(e.acceptance, 'none');
});

test('追加后可重读；坏行不崩', () => {
  const dir = tmp();
  const file = path.join(dir, 'l.jsonl');
  try {
    appendLedger(file, ledgerEntry({ issue: 1 }));
    appendLedger(file, ledgerEntry({ issue: 2 }));
    writeFileSync(file, 'oops\n', { flag: 'a' });
    const { records, bad } = readLedger(file);
    assert.equal(records.length, 2);
    assert.equal(bad, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('渲染含十列中的关键列；空台账不崩', () => {
  const md = renderMarkdown({ records: [ledgerEntry({ issue: 5, acceptanceVerdict: 'pass', semantic: 'ok', files: 2, cny: 0.5 })] });
  assert.ok(md.includes('#5'));
  assert.ok(md.includes('pass'));
  assert.ok(md.includes('¥0.500'));
  assert.ok(renderMarkdown({ records: [] }).includes('没有记录'));
});

test('CLI：未知参数 exit 2；正常 exit 0', () => {
  const dir = tmp();
  const outs = [];
  const io = { out: (s) => outs.push(s), err: () => {} };
  try {
    assert.equal(runCli(['--bogus'], io), 2);
    const file = path.join(dir, 'l.jsonl');
    appendLedger(file, ledgerEntry({ issue: 3 }));
    assert.equal(runCli(['--file', file], io), 0);
    assert.ok(outs.some((s) => s.includes('#3')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
