import test from 'node:test';
import assert from 'node:assert/strict';
import { isFreePoolDown, freePoolDecision, blockReason } from '../ci/pool-block.mjs';

test('额度类报错被认成免费池不可用', () => {
  assert.equal(isFreePoolDown('dsh: QUOTA: 429: {"message":"insufficient balance"}'), true);
  assert.equal(isFreePoolDown('余额不足，请充值'), true);
  assert.equal(isFreePoolDown('no available model for this route'), true);
  assert.equal(isFreePoolDown('assert.equal(divide(6, 3), 2) failed'), false);
});

test('策略启用时：免费池不可用 → 挂起，而不是自动烧付费', () => {
  assert.equal(
    freePoolDecision({ text: 'insufficient balance', zeroTries: 0, usePaid: false, enabled: true }),
    'block',
  );
});

test('连续 0 token 也按免费池不可用处理', () => {
  assert.equal(freePoolDecision({ text: 'agent-exit-1', zeroTries: 2, zeroLimit: 2, usePaid: false, enabled: true }), 'block');
  assert.equal(freePoolDecision({ text: 'agent-exit-1', zeroTries: 1, zeroLimit: 2, usePaid: false, enabled: true }), 'none');
});

test('策略关闭时仍可退回自动切付费（向后兼容）', () => {
  assert.equal(freePoolDecision({ text: 'insufficient balance', usePaid: false, enabled: false }), 'paid');
});

test('已经走付费的单，不再判定为免费池问题', () => {
  assert.equal(freePoolDecision({ text: 'insufficient balance', zeroTries: 5, usePaid: true, enabled: true }), 'none');
});

test('普通失败不触发任何特殊处置', () => {
  assert.equal(freePoolDecision({ text: '独立门禁未通过：tests 193 < 194', zeroTries: 0, usePaid: false, enabled: true }), 'none');
});

test('挂起原因能区分额度与 0 token', () => {
  assert.equal(blockReason({ text: 'insufficient balance', zeroTries: 0 }), '免费池报额度/余额不可用');
  assert.equal(blockReason({ text: 'agent-exit-1', zeroTries: 3 }), '连续 3 次 0 token（模型没开始干活）');
});
