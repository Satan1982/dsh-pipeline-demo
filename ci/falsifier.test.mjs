import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBaseline, countAssertions, findNewExports, countRefs,
  checkAssertDelta, checkSymbolBinding, checkEvidence, summarize,
} from './falsifier.mjs';

const DIFF = [
  'diff --git a/src/a.test.js b/src/a.test.js',
  '--- a/src/a.test.js',
  '+++ b/src/a.test.js',
  '@@ -1,3 +1,5 @@',
  " test('x', () => {",
  "-  assert.equal(add(1, 2), 3);",
  "+  assert.equal(add(1, 2), 3);",
  "+  assert.equal(add(2, 2), 4);",
  "+  t.is(add(3, 3), 6);",
  ' });',
  'diff --git a/src/a.js b/src/a.js',
  '+++ b/src/a.js',
  '+  assert.ok(true); // 生产代码里的断言不计',
].join('\n');

test('parseBaseline 读首行 tests/asserts/sha', () => {
  assert.deepEqual(parseBaseline('456 1217 b409bd9c\n'), { tests: 456, asserts: 1217, sha: 'b409bd9c' });
  assert.equal(parseBaseline('\n'), null);
});

test('countAssertions 只数测试文件的断言行增删', () => {
  assert.deepEqual(countAssertions(DIFF), { added: 2, removed: 1 });
});

test('判据1：基线与 diff 一致 → pass', () => {
  const r = checkAssertDelta({ base: { tests: 10, asserts: 42 }, head: { tests: 11, asserts: 43 }, added: 2, removed: 1 });
  assert.equal(r.result, 'pass');
});

test('判据1：故意改小基线断言数 → fail 并指出文件行', () => {
  const r = checkAssertDelta({ base: { tests: 10, asserts: 42 }, head: { tests: 10, asserts: 40 }, added: 0, removed: 0 });
  assert.equal(r.result, 'fail');
  assert.match(r.detail, /scripts\/test-baseline\.txt:1/);
  assert.match(r.detail, /断言数与 diff 不一致/);
});

test('判据1：测试数下降 → fail；缺基线 → skip', () => {
  assert.equal(checkAssertDelta({ base: { tests: 10, asserts: 42 }, head: { tests: 9, asserts: 42 } }).result, 'fail');
  assert.equal(checkAssertDelta({ base: null, head: null }).result, 'skip');
});

test('findNewExports 只认新增行里的 function/class/const 导出', () => {
  const diff = ['+++ b/ci/x.js', '+export function alpha() {}', '+export const beta = 1;', '-export function old() {}', '+export async function gamma() {}'].join('\n');
  assert.deepEqual(findNewExports(diff).map((x) => x.symbol), ['alpha', 'beta', 'gamma']);
});

test('countRefs 按标识符边界计数', () => {
  assert.equal(countRefs('alpha(); alphaBeta();', 'alpha'), 1);
});

test('判据2：新导出符号无测试引用 → warn；有引用 → pass', () => {
  const exportsList = [{ symbol: 'alpha', file: 'ci/x.js' }];
  const w = checkSymbolBinding({ exports: exportsList, testSource: 'beta();' });
  assert.equal(w.result, 'warn');
  assert.match(w.detail, /alpha/);
  assert.equal(checkSymbolBinding({ exports: exportsList, testSource: 'alpha();' }).result, 'pass');
  assert.equal(checkSymbolBinding({ exports: [], testSource: '' }).result, 'pass');
});

test('判据3：声明 PASS 与实际一致 → pass', () => {
  assert.equal(checkEvidence({ declared: 'pass', code: 0, out: 'ok\nVERDICT: PASS' }).result, 'pass');
});

test('判据3：伪绿/矛盾 → fail', () => {
  assert.equal(checkEvidence({ declared: 'pass', code: 1, out: 'VERDICT: PASS' }).result, 'fail');
  assert.equal(checkEvidence({ declared: 'pass', code: 0, out: 'VERDICT: FAIL' }).result, 'fail');
  assert.equal(checkEvidence({ declared: 'unknown', code: 0, out: 'VERDICT: FAIL' }).result, 'fail');
});

test('summarize：fail > warn > pass', () => {
  assert.equal(summarize([{ result: 'pass' }, { result: 'warn' }]), 'warn');
  assert.equal(summarize([{ result: 'warn' }, { result: 'fail' }]), 'fail');
  assert.equal(summarize([]), 'pass');
});
