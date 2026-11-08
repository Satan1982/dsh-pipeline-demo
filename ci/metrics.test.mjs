import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFirstError, formatInterval, parseFirstError, summarizePass3, wilsonInterval } from './metrics.mjs';

test('wilsonInterval 对 7/10 给出已知区间', () => {
  const iv = wilsonInterval(7, 10);
  assert.ok(Math.abs(iv.p - 0.7) < 1e-9);
  // 标准 Wilson 95%：7/10 ≈ [39.7%, 89.2%]
  assert.ok(Math.abs(iv.low - 0.3968) < 0.01, `low=${iv.low}`);
  assert.ok(Math.abs(iv.high - 0.8922) < 0.01, `high=${iv.high}`);
  assert.equal(formatInterval(iv), '[39.7%, 89.2%]');
});

test('wilsonInterval 拒绝越界样本', () => {
  assert.throws(() => wilsonInterval(3, 2), RangeError);
  assert.throws(() => wilsonInterval(0, 0), RangeError);
  assert.throws(() => wilsonInterval(-1, 2), RangeError);
});

test('summarizePass3 在 n<36 时只报原始比例，不下 0.7 结论', () => {
  const summary = summarizePass3([
    { id: 'a', runs: [true, true, true] },
    { id: 'b', runs: [true, true, true] },
    { id: 'c', runs: [true, false, true] },
  ]);
  assert.equal(summary.n, 3);
  assert.equal(summary.pass3, 2);
  assert.equal(summary.canClaim, false);
  assert.match(summary.verdict, /n=3 < 36/);
  assert.match(summary.verdict, /只报原始比例 66\.7%/);
  assert.match(summary.verdict, /Wilson 95%/);
});

test('summarizePass3 在 n≥36 时允许对照 0.7', () => {
  const tasks = Array.from({ length: 36 }, (_, i) => ({ id: `t${i}`, runs: [i < 26, i < 26, i < 26] }));
  const summary = summarizePass3(tasks);
  assert.equal(summary.n, 36);
  assert.equal(summary.pass3, 26);
  assert.equal(summary.canClaim, true);
  assert.equal(summary.meetsTarget, true);
  assert.match(summary.verdict, /n=36 ≥ 36/);
  assert.match(summary.verdict, /达标/);
});

test('summarizePass3 把没跑满 3 次的样本算未通过并单列', () => {
  const summary = summarizePass3([
    { id: 'full', runs: [true, true, true] },
    { id: 'short', runs: [true, true] },
  ]);
  assert.equal(summary.pass3, 1);
  assert.deepEqual(summary.incomplete, ['short']);
  assert.equal(summary.rows.find((r) => r.id === 'short').passed, false);
});

test('summarizePass3 拒绝空任务表', () => {
  assert.throws(() => summarizePass3([]), TypeError);
});

test('parseFirstError 解析 TAP 的 not ok 行', () => {
  const parsed = parseFirstError('# tests 2\nnot ok 1 - add\n  ---\n  error: 1 != 5\n');
  assert.equal(parsed.found, true);
  assert.equal(parsed.kind, 'tap');
  assert.equal(parsed.test, 'add');
});

test('parseFirstError 解析 spec 的 failing tests 块', () => {
  const parsed = parseFirstError('✖ failing tests:\n✖ clamp (1.2ms)\n  test at /tmp/x.test.js:12:3\n');
  assert.equal(parsed.found, true);
  assert.equal(parsed.kind, 'spec');
  assert.equal(parsed.test, 'clamp');
  assert.equal(parsed.file, '/tmp/x.test.js');
  assert.equal(parsed.line, 12);
});

test('parseFirstError 解析不到失败测试时不编造', () => {
  assert.deepEqual(parseFirstError('VERDICT: PASS\n'), { found: false });
  assert.deepEqual(parseFirstError(''), { found: false });
});

test('formatFirstError 带文件行号', () => {
  assert.equal(formatFirstError({ found: true, test: 'add', file: 'src/index.test.js', line: 5 }), 'add @ src/index.test.js:5');
  assert.equal(formatFirstError({ found: false }), '（未解析到失败测试）');
});
