import test from 'node:test';
import assert from 'node:assert/strict';

import { reviewDiff, formatFindings } from './review.mjs';

const file = (filename, patch) => ({ filename, patch });

test('干净的改动通过评审', () => {
  const r = reviewDiff({ files: [
    file('src/index.js', '+export function negate(n) { return -n; }'),
    file('src/index.test.js', '+test("negate", () => {\n+  assert.equal(negate(3), -3);\n+});'),
    file('scripts/test-baseline.txt', '-21 49\n+22 50'),
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 0);
});

test('拦下调试残留 BROKEN', () => {
  const r = reviewDiff({ files: [
    file('src/index.js', '+export const BROKEN = 0;'),
    file('src/index.test.js', '+assert.equal(add(1, 1), 2);'),
    file('scripts/test-baseline.txt', '-21 49\n+21 50'),
  ] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.rule === 'debug-residue'));
});

test('拦下删除用例', () => {
  const r = reviewDiff({ files: [
    file('src/index.test.js', "-test('divide rejects zero divisor', () => {\n-  assert.throws(() => divide(1, 0), /zero/);\n-});"),
    file('scripts/test-baseline.txt', '-21 49\n+20 48'),
  ] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.rule === 'test-removed'));
  assert.ok(r.findings.some((f) => f.rule === 'assert-removed'));
});

test('拦下改了测试却没更新基线（漏 bless）', () => {
  const r = reviewDiff({ files: [
    file('src/index.test.js', '+test("x", () => {\n+  assert.equal(1, 1);\n+});'),
  ] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.rule === 'baseline-unsynced'));
});

test('拦下改 CI 定义与新增依赖', () => {
  const r = reviewDiff({ files: [
    file('.github/workflows/ci.yml', '+  skip: true'),
    file('package.json', '+  "dependencies": {'),
    file('src/index.test.js', '+assert.equal(1, 1);'),
    file('scripts/test-baseline.txt', '-21 49\n+21 50'),
  ] });
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.rule === 'forbidden-path'));
  assert.ok(r.findings.some((f) => f.rule === 'dependency-added'));
});

test('大改动只是提示，不阻断', () => {
  const many = Array.from({ length: 401 }, (_, i) => `+const v${i} = ${i};`).join('\n');
  const r = reviewDiff({ files: [file('src/big.js', many)] });
  assert.equal(r.ok, true);
  assert.ok(r.findings.some((f) => f.severity === 'warn' && f.rule === 'diff-large'));
});

test('formatFindings 区分阻断与提示', () => {
  const r = reviewDiff({ files: [file('src/index.js', '+debugger;')] });
  const s = formatFindings(r);
  assert.ok(s.includes('✗ 阻断'));
  assert.equal(formatFindings({ findings: [] }), '评审通过：没有发现问题。');
});
