import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels, staleTargets, planProbe, probeArgv, summarizeProbe, DEFAULT_LIMIT } from '../ci/probe-plan.mjs';

test('listModels：接受 models 包一层、纯对象、数组三种形状', () => {
  assert.deepEqual(listModels({ models: { a: { status: 'ok' } } }), [{ id: 'a', status: 'ok' }]);
  assert.deepEqual(listModels({ b: { status: 'stale' } }), [{ id: 'b', status: 'stale' }]);
  assert.deepEqual(listModels([{ id: 'c', status: 'down' }]), [{ id: 'c', status: 'down' }]);
  assert.deepEqual(listModels(null), []);
  assert.deepEqual(listModels({ x: 'ok' }), [{ id: 'x', status: 'ok' }]);
});

test('staleTargets：只挑 stale/unknown，stale 优先，按 id 排序', () => {
  const stats = {
    ok1: { status: 'ok' },
    s2: { status: 'stale' },
    u1: { status: 'unknown' },
    s1: { status: 'stale' },
    d1: { status: 'down' },
  };
  assert.deepEqual(staleTargets(stats), ['s1', 's2', 'u1']);
});

test('staleTargets：limit 生效、默认值明确、非法 limit 不炸', () => {
  const stats = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${String(i).padStart(2, '0')}`, { status: 'stale' }]));
  assert.equal(staleTargets(stats).length, DEFAULT_LIMIT);
  assert.equal(staleTargets(stats, { limit: 3 }).length, 3);
  assert.deepEqual(staleTargets(stats, { limit: 0 }), []);
  assert.deepEqual(staleTargets(stats, { limit: 'x' }), []);
});

test('staleTargets：没有 stale/unknown 时返回空，不去探 ok 的', () => {
  assert.deepEqual(staleTargets({ a: { status: 'ok' }, b: { status: 'degraded' } }), []);
});

test('probeArgv：拼 --only 与 --quiet；空清单不拼（--only "" 会变成测全部）', () => {
  assert.deepEqual(probeArgv(['a', 'b']), ['--only', 'a,b', '--quiet']);
  assert.deepEqual(probeArgv([]), []);
  assert.deepEqual(probeArgv(['a'], { quiet: false }), ['--only', 'a']);
});

test('summarizeProbe：只留含结论的行，取最后几行', () => {
  const out = ['模型 A ok', '', '模型 B fail 429', '模型 C ok', '总计 3 个模型：2 ok / 1 fail'].join('\n');
  assert.deepEqual(summarizeProbe(out), ['模型 B fail 429', '模型 C ok', '总计 3 个模型：2 ok / 1 fail']);
  assert.equal(summarizeProbe(out, { maxLines: 1 }).length, 1);
  assert.deepEqual(summarizeProbe('没有有用信息'), []);
});

test('planProbe：付费模型默认跳过，跳过数单独报出来', () => {
  const stats = { 'glm-5.2': { status: 'stale' }, 'free/a': { status: 'stale' }, 'free/b': { status: 'unknown' } };
  const paid = (id) => id.startsWith('glm');
  const plan = planProbe(stats, { limit: 8, paid });
  assert.deepEqual(plan.picked, ['free/a', 'free/b']);
  assert.equal(plan.stale, 3);
  assert.equal(plan.candidates, 2);
  assert.equal(plan.skippedPaid, 1);
  assert.deepEqual(plan.skippedPaidIds, ['glm-5.2']);
});

test('planProbe：全是付费时 picked 为空（别拼 --only 空串）', () => {
  const stats = { a: { status: 'stale' }, b: { status: 'unknown' } };
  const plan = planProbe(stats, { paid: () => true });
  assert.deepEqual(plan.picked, []);
  assert.equal(plan.skippedPaid, 2);
  assert.equal(plan.candidates, 0);
  assert.deepEqual(probeArgv(plan.picked), []);
});

test('probeArgv：--include-paid 只在显式打开时拼', () => {
  assert.deepEqual(probeArgv(['a'], { includePaid: true }), ['--only', 'a', '--include-paid', '--quiet']);
  assert.deepEqual(probeArgv(['a']), ['--only', 'a', '--quiet']);
});
