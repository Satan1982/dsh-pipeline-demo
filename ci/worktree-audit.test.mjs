import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorktreeDirs, auditWorktrees, formatAudit } from '../ci/worktree-audit.mjs';

test('只认 issue-<号>，派生目录与非数字目录跳过', () => {
  const got = parseWorktreeDirs(['issue-12', 'issue-12-ci', 'issue-12-rebase', 'reb69', '.git', 'issue-x']);
  assert.deepEqual(got, [{ n: 12, dir: 'issue-12' }]);
});

test('对得上 open 工单的不报，剩下的都报', () => {
  const stale = auditWorktrees({ dirs: ['issue-1', 'issue-2', 'issue-3'], openNumbers: [2] });
  assert.deepEqual(stale.map((s) => s.n), [1, 3]);
  assert.equal(stale[0].dirty, false);
});

test('有未提交改动的标 dirty，日志措辞不同', () => {
  const stale = auditWorktrees({ dirs: ['issue-7'], openNumbers: [], dirty: { 'issue-7': true } });
  assert.equal(stale[0].dirty, true);
  assert.match(formatAudit(stale)[0], /不自动删/);
  const clean = auditWorktrees({ dirs: ['issue-7'], openNumbers: [] });
  assert.match(formatAudit(clean)[0], /可移除/);
});

test('空目录/空 open 不炸', () => {
  assert.deepEqual(auditWorktrees({}), []);
  assert.deepEqual(formatAudit(auditWorktrees({ dirs: [] })), []);
});
