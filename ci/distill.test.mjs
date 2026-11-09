import test from 'node:test';
import assert from 'node:assert/strict';

import { clean, group, render, renderPoolSection } from './distill-failures.mjs';
import { poolTrend } from './pool-trend.mjs';

test('同一个指纹的多条记录归并成一条，次数与工单都留下', () => {
  const groups = group([
    { fp: 'aaa', reason: 'Error: 独立门禁未通过', issue: 27, at: '2026-10-25T01:00:00Z' },
    { fp: 'aaa', reason: 'Error: 独立门禁未通过', issue: 44, at: '2026-10-25T02:00:00Z' },
    { fp: 'bbb', reason: 'Error: 验收命令未通过', issue: 49, at: '2026-10-25T03:00:00Z' },
  ]);
  assert.equal(groups.length, 2);
  const a = groups.find((g) => g.fp === 'aaa');
  assert.equal(a.count, 2);
  assert.deepEqual([...a.issues].sort(), [27, 44]);
  assert.equal(a.last, '2026-10-25T02:00:00Z');
});

test('调用栈与本机路径不进摘要', () => {
  const raw = 'Error: 评审层拒绝\n    at runTask (file:///<工作盘>/x.mjs:451:15)\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)';
  const out = clean(raw);
  assert.equal(out, 'Error: 评审层拒绝');
  assert.ok(!out.includes('runTask'));
  assert.ok(!out.includes('node:internal'));
});

test('摘要按出现次数排序，并写明来源与条数', () => {
  const text = render(group([
    { fp: 'low', reason: 'rare' },
    { fp: 'high', reason: 'common' },
    { fp: 'high', reason: 'common' },
  ]));
  assert.ok(text.includes('共 2 个根因'));
  assert.ok(text.toLowerCase().includes('docs/failures.jsonl') || text.includes('failures.jsonl'));
  assert.ok(text.indexOf('## 2 次') < text.indexOf('## 1 次'));
});

test('池子健康单独成段：带截止时间与「不是当前可用性」', () => {
  const rows = [
    { at: '2026-11-01T00:00:00Z', atMs: Date.UTC(2026, 10, 1), ok: 20, total: 158 },
    { at: '2026-11-02T00:00:00Z', atMs: Date.UTC(2026, 10, 2), ok: 18, total: 158 },
  ];
  const section = renderPoolSection(poolTrend(rows));
  assert.match(section, /^## 免费模型池健康（近 14 天，快照截止 2026-11-02/);
  assert.match(section, /不是当前可用性/);
});

test('池子快照坏掉时出「快照不可用」，不静默省略', () => {
  const section = renderPoolSection(null, { problem: '快照文件读不了（EACCES）：x.jsonl' });
  assert.match(section, /快照不可用/);
  assert.match(section, /EACCES/);
  assert.equal(renderPoolSection(null), '');
});
