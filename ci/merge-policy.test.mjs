import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowlist, autoMergeAllowed, decideAutoMerge, ENV_KEY, PILOT_REPO, AUTO_MERGE_ENABLED } from '../ci/merge-policy.mjs';

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

test('v3 P0：默认关闭自动合并（任何仓库/标签/CI 绿都不放行）', () => {
  const allowlist = parseAllowlist('Satan1982/real-repo');
  const r = decideAutoMerge({
    repo: 'satan1982/real-repo', allowlist, labels: ['merge:auto'], body: 'plain',
    ciConclusion: 'success', mergeState: 'clean',
  });
  assert.equal(AUTO_MERGE_ENABLED, false);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'auto-merge-disabled');
  assert.match(r.why, /merge:verified/);
});

test('显式 enabled:true 时旧判据仍逐个拦住（白名单之外）', () => {
  const allowlist = parseAllowlist(undefined);
  const r = decideAutoMerge({
    repo: 'Satan1982/real-repo', allowlist, enabled: true,
    labels: ['merge:auto'], ciConclusion: 'success', mergeState: 'clean',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'repo-not-allowed');
  assert.match(r.why, /不在自动合并白名单/);
});

test('显式 enabled:true 时旧判据仍逐个拦住（缺标签/降级/CI/可合并）', () => {
  const allowlist = parseAllowlist(PILOT_REPO);
  assert.equal(decideAutoMerge({ repo: PILOT_REPO, allowlist, enabled: true, labels: [] }).code, 'no-label');
  assert.equal(decideAutoMerge({
    repo: PILOT_REPO, allowlist, enabled: true, labels: ['merge:auto'], body: '<!-- semantic:needs-human -->',
  }).code, 'review-degraded');
  assert.equal(decideAutoMerge({
    repo: PILOT_REPO, allowlist, enabled: true, labels: ['merge:auto'], ciConclusion: 'failure',
  }).code, 'ci-not-green');
  assert.equal(decideAutoMerge({
    repo: PILOT_REPO, allowlist, enabled: true, labels: ['merge:auto'], mergeState: 'behind',
  }).code, 'merge-behind');
});

test('显式 enabled:true 且四条件全满足才 ok（仅测试可达）', () => {
  const allowlist = parseAllowlist('Satan1982/real-repo');
  const r = decideAutoMerge({
    repo: 'satan1982/real-repo', allowlist, enabled: true,
    labels: ['merge:auto'], body: 'plain', ciConclusion: 'success', mergeState: 'clean',
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'ok');
});

test('ENV_KEY 名字稳定（调度器与文档都按它配）', () => {
  assert.equal(ENV_KEY, 'DSH_AUTO_MERGE_REPOS');
});
