import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BEAT_STALE_MS, modeOf, staleLimitMs, lockHeld, lockPayload } from '../ci/lock-policy.mjs';

const STALE = 40 * 60 * 1000;
const MIN = 60 * 1000;

test('serve：心跳停 2 分钟仍算持有', () => {
  assert.equal(lockHeld({ alive: true, ageMs: 2 * MIN, mode: 'serve', staleMs: STALE }), true);
});

test('serve：心跳停 5 分钟判陈旧（卡死的常驻不必等 40 分钟）', () => {
  assert.equal(lockHeld({ alive: true, ageMs: 5 * MIN, mode: 'serve', staleMs: STALE }), false);
});

test('once：干长任务 30 分钟不心跳也不算陈旧', () => {
  assert.equal(lockHeld({ alive: true, ageMs: 30 * MIN, mode: 'once', staleMs: STALE }), true);
});

test('once：超过 40 分钟才判陈旧', () => {
  assert.equal(lockHeld({ alive: true, ageMs: STALE, mode: 'once', staleMs: STALE }), false);
});

test('老锁没有 mode 时按 once 处理（宁可多等，不误杀长任务）', () => {
  assert.equal(modeOf(undefined), 'once');
  assert.equal(modeOf('once'), 'once');
  assert.equal(modeOf('serve'), 'serve');
  assert.equal(lockHeld({ alive: true, ageMs: 20 * MIN, mode: undefined, staleMs: STALE }), true);
});

test('进程不在就是陈旧，与心跳无关', () => {
  assert.equal(lockHeld({ alive: false, ageMs: 0, mode: 'serve', staleMs: STALE }), false);
  assert.equal(lockHeld({ alive: true, ageMs: NaN, mode: 'serve', staleMs: STALE }), false);
});

test('阈值可调：beatStaleMs 覆盖默认值', () => {
  assert.equal(staleLimitMs('serve', { staleMs: STALE }), DEFAULT_BEAT_STALE_MS);
  assert.equal(staleLimitMs('serve', { staleMs: STALE, beatStaleMs: 10 * MIN }), 10 * MIN);
  assert.equal(staleLimitMs('once', { staleMs: STALE, beatStaleMs: 10 * MIN }), STALE);
  assert.equal(lockHeld({ alive: true, ageMs: 11 * MIN, mode: 'serve', staleMs: STALE, beatStaleMs: 10 * MIN }), false);
});

test('锁内容带 pid / 时间 / 模式', () => {
  const p = lockPayload({ pid: 123, at: '2026-10-28T00:00:00.000Z', mode: 'serve' });
  assert.deepEqual(p, { pid: 123, at: '2026-10-28T00:00:00.000Z', mode: 'serve' });
  assert.equal(lockPayload({ pid: 1, at: 'x', mode: 'once' }).mode, 'once');
});
