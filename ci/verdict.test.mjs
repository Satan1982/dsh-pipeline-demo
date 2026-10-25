import test from 'node:test';
import assert from 'node:assert/strict';

import { parseVerdict, decideAcceptance } from './verdict.mjs';

test('parseVerdict finds PASS / FAIL and keeps the trailing reason', () => {
  assert.deepEqual(parseVerdict('some log\nVERDICT: PASS\n'), { verdict: 'pass', reason: '' });
  assert.deepEqual(parseVerdict('VERDICT: FAIL median([]) 返回 0'), { verdict: 'fail', reason: 'median([]) 返回 0' });
});

test('parseVerdict takes the last verdict line and ignores prose mentions', () => {
  const text = '打印 VERDICT: PASS 的说明行不算\nVERDICT: FAIL 第一次\nVERDICT: PASS 第二次';
  assert.deepEqual(parseVerdict(text), { verdict: 'pass', reason: '第二次' });
});

test('parseVerdict reports unknown when nothing matches', () => {
  assert.deepEqual(parseVerdict('全部断言通过'), { verdict: 'unknown', reason: '' });
  assert.deepEqual(parseVerdict(''), { verdict: 'unknown', reason: '' });
});

test('decideAcceptance lets exit 0 without a verdict pass but says so', () => {
  const d = decideAcceptance({ code: 0, out: 'ok', err: '' });
  assert.equal(d.ok, true);
  assert.equal(d.verdict, 'unknown');
  assert.match(d.detail, /没有 VERDICT 行/);
});

test('decideAcceptance fails when the verdict says FAIL even if exit is 0', () => {
  const d = decideAcceptance({ code: 0, out: 'VERDICT: FAIL 少了 median 的 RangeError', err: '' });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, 'fail');
  assert.match(d.detail, /RangeError/);
});

test('decideAcceptance fails when the command crashed even if it printed PASS', () => {
  const d = decideAcceptance({ code: 1, out: 'VERDICT: PASS', err: '' });
  assert.equal(d.ok, false);
  assert.match(d.detail, /exit=1/);
});

test('decideAcceptance honours verdict:strict for a missing verdict line', () => {
  const d = decideAcceptance({ code: 0, out: 'ok', err: '' }, { strict: true });
  assert.equal(d.ok, false);
  assert.equal(d.verdict, 'unknown');
  assert.match(d.detail, /verdict:strict/);
});
