// agent:blocked 重投判据（云端唯一通道，2026-11-08 起本地大模型档已删除）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRequeue } from '../ci/requeue-policy.mjs';

test('付费档且云端可用 → 重投', () => {
  const v = decideRequeue({ paid: true, cloud: { ok: true, why: '3/7 个模型 ok' } });
  assert.equal(v.ok, true);
  assert.match(v.why, /付费档可用/);
});

test('免费档云端可用 → 重投', () => {
  const v = decideRequeue({ paid: false, cloud: { ok: true, why: '2/9 个模型 ok' } });
  assert.equal(v.ok, true);
  assert.match(v.why, /云端可用/);
});

test('云端不可用 → 不重投，理由带云端原因', () => {
  const v = decideRequeue({ paid: false, cloud: { ok: false, why: '没有 ok 模型' } });
  assert.equal(v.ok, false);
  assert.match(v.why, /没有 ok 模型/);
});

test('云端快照缺失 → 不重投，理由为未知而不是抛错', () => {
  const v = decideRequeue({ paid: false, cloud: undefined });
  assert.equal(v.ok, false);
  assert.match(v.why, /未知/);
});

test('付费档在云端不可用时也不重投', () => {
  const v = decideRequeue({ paid: true, cloud: { ok: false, why: '全部 down' } });
  assert.equal(v.ok, false);
  assert.match(v.why, /全部 down/);
});

test('判据不再提本地档（残留本地路由会让重投重新依赖 Lemonade）', () => {
  const v = decideRequeue({ paid: false, cloud: { ok: false, why: '云端全挂' } });
  assert.equal(/本地/.test(v.why), false);
});

test('为什么字符串原样透传，便于日志定位', () => {
  const v = decideRequeue({ paid: false, cloud: { ok: true, why: 'degraded: 1 ok' } });
  assert.equal(v.why.includes('degraded: 1 ok'), true);
});

test('返回值形状稳定（只有 ok/why）', () => {
  const v = decideRequeue({ paid: false, cloud: { ok: true, why: 'x' } });
  assert.deepEqual(Object.keys(v).sort(), ['ok', 'why']);
});
