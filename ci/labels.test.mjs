import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_LABELS, missingLabels, labelPayload, formatLabelList } from '../ci/labels.mjs';

test('空仓库：清单里的标签全缺，顺序不变', () => {
  const miss = missingLabels([]);
  assert.equal(miss.length, REQUIRED_LABELS.length);
  assert.equal(miss[0], 'agent:ready');
  assert.equal(miss[miss.length - 1], 'verdict:strict');
});

test('只缺一个时只报那一个（giveup 分支依赖的标签）', () => {
  const existing = REQUIRED_LABELS.filter((n) => n !== 'agent:blocked:manual');
  assert.deepEqual(missingLabels(existing), ['agent:blocked:manual']);
});

test('全都有时为空，不重复建', () => {
  assert.deepEqual(missingLabels(REQUIRED_LABELS), []);
});

test('GitHub 返回的对象数组也能比对，且忽略大小写与空格', () => {
  const existing = REQUIRED_LABELS.map((name) => ({ name: name.toUpperCase() }));
  existing[0] = { name: `  ${existing[0].name}  ` };
  assert.deepEqual(missingLabels(existing), []);
});

test('人手加的 dep-on:* 不会被当成「缺」，也不在清单里', () => {
  assert.deepEqual(missingLabels([...REQUIRED_LABELS, 'dep-on:T1']), []);
  assert.equal(REQUIRED_LABELS.some((n) => n.startsWith('dep-on:')), false);
});

test('建标签的请求体带 name 与颜色，未知标签只给 name', () => {
  const body = labelPayload('agent:blocked:manual');
  assert.equal(body.name, 'agent:blocked:manual');
  assert.match(body.color, /^[0-9a-f]{6}$/);
  assert.equal(typeof body.description, 'string');
  assert.deepEqual(labelPayload('dep-on:T1'), { name: 'dep-on:T1' });
});

test('日志列表过长时截断并报总数', () => {
  assert.equal(formatLabelList(['a', 'b']), 'a、b');
  assert.equal(formatLabelList([]), '（无）');
  assert.equal(formatLabelList(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'a、b、c、d、e、f 等 7 个');
});
