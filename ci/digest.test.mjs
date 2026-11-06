// digest 的回归测试：坏行不崩、时间窗正确、空文件也算成功。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEvents, renderMarkdown, runCli, summarize } from './digest.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'digest-'));

test('解析：坏行只计数，不影响其余记录', () => {
  const { records, bad } = parseEvents('{"at":"2026-11-06T10:00:00.000Z","kind":"failed"}\nnot-json\n\n{"kind":"daycap"}');
  assert.equal(records.length, 2);
  assert.equal(bad, 1);
});

test('时间窗：只留窗口内的记录，按类别计数', () => {
  const now = new Date('2026-11-06T10:00:00.000Z');
  const records = [
    { at: '2026-11-06T09:00:00.000Z', kind: 'failed' },
    { at: '2026-11-06T08:00:00.000Z', kind: 'failed' },
    { at: '2026-11-01T09:00:00.000Z', kind: 'daycap' },
  ];
  const s = summarize(records, { sinceMs: now.getTime() - 24 * 3600 * 1000 });
  assert.equal(s.kept.length, 2);
  assert.deepEqual(s.byKind, { failed: 2 });
});

test('渲染：空事件给出明确提示，有事件时带中文类别名', () => {
  const md = renderMarkdown({ kept: [], byKind: {}, bad: 0 }, { now: new Date('2026-11-06T00:00:00Z'), days: 1 });
  assert.ok(md.includes('没有事件'));
  const withRows = renderMarkdown({
    kept: [{ at: '2026-11-06T09:00:00.000Z', kind: 'failed', issue: 3, why: '验收失败' }],
    byKind: { failed: 1 }, bad: 2,
  }, { now: new Date('2026-11-06T10:00:00Z'), days: 1 });
  assert.ok(withRows.includes('任务失败'));
  assert.ok(withRows.includes('#3'));
  assert.ok(withRows.includes('2 行无法解析'));
});

test('runCli：文件不存在也 exit 0；未知参数 exit 2', () => {
  const dir = tmp();
  const outs = [];
  const errs = [];
  const io = { out: (s) => outs.push(s), err: (s) => errs.push(s) };
  try {
    const file = path.join(dir, 'none.jsonl');
    assert.equal(runCli(['--file', file], io), 0);
    assert.ok(outs.some((s) => s.includes('没有事件')));
    assert.equal(runCli(['--bogus'], io), 2);
    const f2 = path.join(dir, 'e.jsonl');
    writeFileSync(f2, '{"at":"2026-11-06T09:00:00.000Z","kind":"failed"}\n');
    assert.equal(runCli(['--file', f2, '--json'], { ...io, now: new Date('2026-11-06T10:00:00.000Z') }), 0);
    assert.ok(outs.some((s) => s.includes('"failed": 1')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
