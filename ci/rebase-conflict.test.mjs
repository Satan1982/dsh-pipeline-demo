import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConflicts } from './rebase-conflict.mjs';

test('两个基线文件冲突时可自动重算', () => {
  const r = classifyConflicts(['scripts/test-baseline.txt', 'scripts/assert-baseline.txt']);
  assert.equal(r.kind, 'baseline-only');
  assert.deepEqual(r.files, ['scripts/test-baseline.txt', 'scripts/assert-baseline.txt']);
});

test('单个基线文件冲突也可自动重算', () => {
  assert.equal(classifyConflicts(['scripts/assert-baseline.txt']).kind, 'baseline-only');
});

test('混入源码文件就要转人工', () => {
  const r = classifyConflicts(['scripts/test-baseline.txt', 'src/strings.js']);
  assert.equal(r.kind, 'manual');
  assert.deepEqual(r.files, ['scripts/test-baseline.txt', 'src/strings.js']);
});

test('没有冲突文件时返回 none', () => {
  assert.equal(classifyConflicts([]).kind, 'none');
  assert.equal(classifyConflicts(undefined).kind, 'none');
  assert.equal(classifyConflicts(['', '  ']).kind, 'none');
});

test('名字相近但不是基线的文件不算可重算', () => {
  assert.equal(classifyConflicts(['scripts/baseline.txt']).kind, 'manual');
  assert.equal(classifyConflicts(['src/test-baseline.txt']).kind, 'manual');
  assert.equal(classifyConflicts(['scripts/test-baseline.txt.bak']).kind, 'manual');
});

test('空白与换行被规整掉', () => {
  const r = classifyConflicts([' scripts/test-baseline.txt\n', 'scripts/assert-baseline.txt ']);
  assert.equal(r.kind, 'baseline-only');
  assert.deepEqual(r.files, ['scripts/test-baseline.txt', 'scripts/assert-baseline.txt']);
});
