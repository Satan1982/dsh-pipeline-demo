import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  normalize, signature, fingerprint, recordFailure, lookup, formatPriorFailures, loadStore,
} from './failures.mjs';

test('normalize 抹掉每次都会变的部分', () => {
  const a = 'Error: verify failed at 2026-10-25T01:02:03.000Z in D:/code/.worktrees/issue-25 after 42s (commit a1b2c3d4e5f6)';
  const b = 'Error: verify failed at 2026-10-26T09:11:12.000Z in D:/code/.worktrees/issue-31 after 7s (commit ffffffffffff)';
  assert.equal(normalize(a), normalize(b));
  assert.ok(!normalize(a).includes('a1b2c3d4e5f6'));
  assert.ok(normalize(a).includes('<path>'));
});

test('相同根因不同噪声得到同一指纹', () => {
  const a = 'exit code 1\n拒绝：测试数量从 17 降到 16（禁止删测试凑绿）\n  at run (D:/code/x.mjs:10:5)';
  const b = 'exit code 1\n拒绝：测试数量从 17 降到 16（禁止删测试凑绿）\n  at run (E:/other/y.mjs:99:1)';
  assert.equal(fingerprint(a), fingerprint(b));
});

test('数字本身仍参与指纹（降 1 个和降 5 个不是同一件事）', () => {
  const a = '拒绝：测试数量从 17 降到 16（禁止删测试凑绿）';
  const b = '拒绝：测试数量从 17 降到 12（禁止删测试凑绿）';
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('不同根因得到不同指纹', () => {
  const a = 'exit code 1\n拒绝：测试数量从 17 降到 16（禁止删测试凑绿）';
  const b = 'exit code 1\nremote: Repository not found.';
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('栈帧不进入签名，签名长度有界', () => {
  const text = 'Error: boom\n  at a (x.js:1:1)\n  at b (y.js:2:2)\nnode:internal/process/task_queues:95:5';
  const sig = signature(text);
  assert.ok(!sig.includes('at a'));
  assert.ok(!sig.includes('node:internal'));
  assert.ok(sig.length <= 600);
});

test('recordFailure 追加写、lookup 折叠计数', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'failstore-'));
  const file = path.join(dir, 'docs/failures.jsonl');
  try {
    const text = 'Error: same thing D:/code/a after 3s';
    recordFailure({ text, issue: 1, attempt: 1, reason: '第一次' }, file);
    recordFailure({ text: text.replace('D:/code/a', 'D:/code/b').replace('3s', '9s'), issue: 2, attempt: 1, reason: '第二次', fix: '删掉坏行' }, file);
    const rec = lookup(text, file);
    assert.ok(rec);
    assert.equal(rec.count, 2);
    assert.deepEqual(rec.issues, [1, 2]);
    assert.equal(rec.fix, '删掉坏行');
    assert.equal(loadStore(file).size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatPriorFailures 命中时给出上次根因与修法，未命中返回空串', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'failstore-'));
  const file = path.join(dir, 'docs/failures.jsonl');
  try {
    assert.equal(formatPriorFailures('Error: 全新错误', file), '');
    const text = 'Error: 老毛病 D:/code/x 12s';
    recordFailure({ text, issue: 7, attempt: 1, reason: '断言被改写', fix: '恢复断言并改代码' }, file);
    const out = formatPriorFailures(text.replace('D:/code/x', 'D:/code/y').replace('12s', '40s'), file);
    assert.ok(out.includes('同一个根因出现过 1 次'));
    assert.ok(out.includes('恢复断言并改代码'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
