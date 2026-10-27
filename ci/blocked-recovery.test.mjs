import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEUE_BACKOFF_MS, MAX_AUTO_REQUEUE, parseBackoff, backoffMs, initialEntry,
  isDue, recoveryDecision, pruneState,
} from '../ci/blocked-recovery.mjs';

const T0 = Date.parse('2026-10-28T00:00:00.000Z');
const MIN = 60 * 1000;

test('退避阶梯：5/10/20/40/60 分钟，之后停在最后一档', () => {
  assert.deepEqual(REQUEUE_BACKOFF_MS, [5 * MIN, 10 * MIN, 20 * MIN, 40 * MIN, 60 * MIN]);
  assert.equal(backoffMs(0), 5 * MIN);
  assert.equal(backoffMs(2), 20 * MIN);
  assert.equal(backoffMs(99), 60 * MIN);
  assert.equal(backoffMs(-3), 5 * MIN);
});

test('parseBackoff 认分钟列表，非法项丢掉，全非法退回默认', () => {
  assert.deepEqual(parseBackoff('1,2.5'), [1 * MIN, 2.5 * MIN]);
  assert.deepEqual(parseBackoff('x,,0,-5,7'), [7 * MIN]);
  assert.deepEqual(parseBackoff(''), REQUEUE_BACKOFF_MS);
});

test('挂起记录：默认 5 分钟后第一次探活，重投次数可跨次继承', () => {
  const e = initialEntry({ now: T0, why: '免费池报额度/余额不可用' });
  assert.equal(e.blockedAt, '2026-10-28T00:00:00.000Z');
  assert.equal(e.nextProbeAt, '2026-10-28T00:05:00.000Z');
  assert.equal(e.requeues, 0);
  assert.equal(e.gaveUp, false);
  assert.equal(initialEntry({ now: T0, requeues: 2 }).requeues, 2);
});

test('isDue：没到点不动，到点才探活，已放弃的不再探', () => {
  const e = initialEntry({ now: T0 });
  assert.equal(isDue(e, T0 + 4 * MIN), false);
  assert.equal(isDue(e, T0 + 5 * MIN), true);
  assert.equal(isDue({ ...e, gaveUp: true }, T0 + 60 * MIN), false);
});

test('池子还没恢复：记一次探活，下次探活按阶梯后移', () => {
  const e = initialEntry({ now: T0 });
  const d = recoveryDecision({ entry: e, now: T0 + 5 * MIN, pool: { ok: false, why: '免费池没有 ok 模型' } });
  assert.equal(d.action, 'wait');
  assert.equal(d.probed, true);
  assert.equal(d.entry.probes, 1);
  assert.equal(d.entry.nextProbeAt, '2026-10-28T00:15:00.000Z');
  assert.equal(d.entry.requeues, 0);
  assert.match(d.reason, /仍不可用/);
});

test('池子恢复：放回 agent:ready，重投次数 +1', () => {
  const e = initialEntry({ now: T0, why: '连续 2 次 0 token' });
  const d = recoveryDecision({ entry: e, now: T0 + 5 * MIN, pool: { ok: true, why: '3/9 个模型 ok' } });
  assert.equal(d.action, 'requeue');
  assert.equal(d.entry.requeues, 1);
  assert.equal(d.entry.gaveUp, false);
  assert.equal(d.entry.lastRequeueAt, '2026-10-28T00:05:00.000Z');
  assert.match(d.reason, /免费池恢复/);
});

test('重投到上限还挂：停止自动恢复，交给人', () => {
  const e = { ...initialEntry({ now: T0 }), requeues: MAX_AUTO_REQUEUE };
  const d = recoveryDecision({ entry: e, now: T0 + 5 * MIN, pool: { ok: true, why: 'ok' } });
  assert.equal(d.action, 'giveup');
  assert.equal(d.entry.gaveUp, true);
  assert.match(d.reason, /已自动重投 3 次/);
});

test('已放弃或没有记录：什么都不做', () => {
  assert.equal(recoveryDecision({ entry: null, now: T0 }).action, 'skip');
  const d = recoveryDecision({ entry: { ...initialEntry({ now: T0 }), gaveUp: true }, now: T0 + 60 * MIN, pool: { ok: true } });
  assert.equal(d.action, 'skip');
});

test('状态文件只留 7 天内动过的条目', () => {
  const fresh = initialEntry({ now: T0, why: '新的' });
  const old = initialEntry({ now: T0 - 10 * 24 * 60 * MIN, why: '旧的' });
  const kept = pruneState({ 1: fresh, 2: old }, { now: T0 });
  assert.deepEqual(Object.keys(kept), ['1']);
});
