import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowlist, autoMergeAllowed, decideAutoMerge, ENV_KEY, PILOT_REPO } from '../ci/merge-policy.mjs';

test('未设环境变量时白名单就是试点仓', () => {
  assert.deepEqual(parseAllowlist(undefined), [PILOT_REPO.toLowerCase()]);
  assert.equal(autoMergeAllowed(PILOT_REPO, parseAllowlist(undefined)), true);
  assert.equal(autoMergeAllowed('Satan1982/real-repo', parseAllowlist(undefined)), false);
});

test('显式白名单按逗号拆、大小写不敏感、去空白', () => {
  const list = parseAllowlist(' Satan1982/Foo , other/Bar ');
  assert.deepEqual(list, ['satan1982/foo', 'other/bar']);
  assert.equal(autoMergeAllowed('Satan1982/FOO', list), true);
  assert.equal(autoMergeAllowed('Satan1982/dsh-pipeline-demo', list), false);
});

test('显式空串 = 全禁（fail-closed，不是「不限」）', () => {
  assert.deepEqual(parseAllowlist(''), []);
  assert.deepEqual(parseAllowlist('  '), []);
  assert.equal(autoMergeAllowed(PILOT_REPO, parseAllowlist('')), false);
});

test('四条件：白名单之外的仓库即使打了 merge:auto 也不合并', () => {
  const allowlist = parseAllowlist(undefined);
  const r = decideAutoMerge({
    repo: 'Satan1982/real-repo', allowlist, labels: ['merge:auto'], ciConclusion: 'success', mergeState: 'clean',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'repo-not-allowed');
  assert.match(r.why, /不在自动合并白名单/);
});

test('四条件：缺标签 / 评审降级 / CI 未绿 / 不可合并逐个拦住', () => {
  const allowlist = parseAllowlist(PILOT_REPO);
  assert.equal(decideAutoMerge({ repo: PILOT_REPO, allowlist, labels: [] }).code, 'no-label');
  assert.equal(decideAutoMerge({
    repo: PILOT_REPO, allowlist, labels: ['merge:auto'], body: '<!-- semantic:needs-human -->',
  }).code, 'review-degraded');
  assert.equal(decideAutoMerge({
    repo: PILOT_REPO, allowlist, labels: ['merge:auto'], ciConclusion: 'failure',
  }).code, 'ci-not-green');
  assert.equal(decideAutoMerge({
    repo: PILOT_REPO, allowlist, labels: ['merge:auto'], mergeState: 'behind',
  }).code, 'merge-behind');
});

test('四条件全满足才 ok', () => {
  const allowlist = parseAllowlist('Satan1982/real-repo');
  const r = decideAutoMerge({
    repo: 'satan1982/real-repo', allowlist, labels: ['merge:auto'], body: 'plain', ciConclusion: 'success', mergeState: 'clean',
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'ok');
});

test('ENV_KEY 名字稳定（调度器与文档都按它配）', () => {
  assert.equal(ENV_KEY, 'DSH_AUTO_MERGE_REPOS');
});
