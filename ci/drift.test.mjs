import test from 'node:test';
import assert from 'node:assert/strict';

import { localDrift, formatDrift } from './drift.mjs';

test('标签与本地都对得上时不报不一致', () => {
  const d = localDrift({ working: [12], worktrees: [12], active: [12] });
  assert.equal(d.ok, true);
  assert.deepEqual(d.orphanLabels, []);
  assert.deepEqual(d.orphanWorktrees, []);
  assert.match(formatDrift(d), /一致/);
});

test('打了 agent:working 但本地没有 worktree 也没有在跑 = 僵尸标签', () => {
  const d = localDrift({ working: [12, 13], worktrees: [13], active: [] });
  assert.equal(d.ok, false);
  assert.deepEqual(d.orphanLabels, [12]);
  assert.match(formatDrift(d), /#12/);
});

test('正在处理的工单不算僵尸（worktree 可能还没建完）', () => {
  const d = localDrift({ working: [20], worktrees: [], active: [20] });
  assert.equal(d.ok, true);
});

test('本地留着 worktree 但工单已不在跑 = 孤儿目录', () => {
  const d = localDrift({ working: [], worktrees: [31, 32], active: [] });
  assert.equal(d.ok, false);
  assert.deepEqual(d.orphanWorktrees, [31, 32]);
  assert.match(formatDrift(d), /worktree/);
});

test('输入是字符串/重复项也能稳定判读', () => {
  const d = localDrift({ working: ['7', '7'], worktrees: ['7'], active: [] });
  assert.equal(d.ok, true);
});
