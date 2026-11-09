import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseAddedLines, mutateLine, planMutations, testPathFor,
  applyMutant, probeMutations, probeWorktree, summarize, TEST_FILE_RE,
} from './mutate.mjs';

test('probeWorktree：非 strict 只扫描不跑测试，strict 才逐个跑受影响测试', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mutate-gate-'));
  try {
    mkdirSync(path.join(dir, 'ci'), { recursive: true });
    writeFileSync(path.join(dir, 'ci', 'demo.mjs'), ['export function check(n) {', '  return n >= 2;', '}'].join('\n'));
    const patch = [
      'diff --git a/ci/demo.mjs b/ci/demo.mjs',
      '--- a/ci/demo.mjs',
      '+++ b/ci/demo.mjs',
      '@@ -1,2 +1,2 @@',
      ' export function check(n) {',
      '-  return n > 2;',
      '+  return n >= 2;',
    ].join('\n');
    let calls = 0;
    const soft = await probeWorktree({ root: dir, patch, runTests: () => { calls += 1; return { code: 0 }; } });
    assert.equal(soft.mutants, 1);
    assert.equal(calls, 0, '非 strict 不许跑测试（成本为 0）');
    assert.equal(soft.verdict, 'PASS');
    const hard = await probeWorktree({ root: dir, patch, strict: true, runTests: () => { calls += 1; return { code: 1 }; } });
    assert.equal(calls, 1);
    assert.equal(hard.killed, 1);
    assert.equal(hard.code, 0);
    const bad = await probeWorktree({ root: dir, patch, strict: true, runTests: () => { calls += 1; return { code: 0 }; } });
    assert.equal(bad.blocked, true);
    assert.equal(bad.code, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 手写一段真实形态的 unified diff：一个源码文件（有新增/删除/上下文）+ 一个测试文件。
const PATCH = [
  'diff --git a/ci/demo.mjs b/ci/demo.mjs',
  '--- a/ci/demo.mjs',
  '+++ b/ci/demo.mjs',
  '@@ -1,3 +1,4 @@',
  ' export function check(n) {',
  '-  return n > 2;',
  '+  return n >= 2 && n < 9;',
  '+  // 这是一行注释',
  ' }',
  'diff --git a/ci/demo.test.mjs b/ci/demo.test.mjs',
  '--- a/ci/demo.test.mjs',
  '+++ b/ci/demo.test.mjs',
  '@@ -1,2 +1,2 @@',
  ' import test from "node:test";',
  '+assert.equal(1, 1);',
].join('\n');

test('parseAddedLines 只取 + 行，并给出新文件里的真实行号', () => {
  const added = parseAddedLines(PATCH);
  assert.deepEqual(added.map((a) => [a.file, a.line, a.text.trim()]), [
    ['ci/demo.mjs', 2, 'return n >= 2 && n < 9;'],
    ['ci/demo.mjs', 3, '// 这是一行注释'],
    ['ci/demo.test.mjs', 2, 'assert.equal(1, 1);'],
  ]);
});

test('planMutations 只变异非测试文件的新增行：测试文件与注释都不能进探针', () => {
  const plan = planMutations({ patch: PATCH });
  assert.equal(plan.added, 3);
  assert.equal(plan.mutants.length, 1);
  const [m] = plan.mutants;
  assert.equal(m.file, 'ci/demo.mjs');
  assert.equal(m.line, 2);
  assert.equal(m.op, 'and-to-or');
  assert.equal(m.after, '  return n >= 2 || n < 9;');
  const whys = plan.skipped.map((s) => s.file + ':' + s.line + ' ' + s.why);
  assert.ok(whys.some((w) => w.includes('测试文件不进探针')));
  assert.ok(whys.some((w) => w.includes('注释行')));
  assert.equal(TEST_FILE_RE.test('ci/demo.test.mjs'), true);
  assert.equal(TEST_FILE_RE.test('src/demo.js'), false);
});

test('mutateLine 一行只产一个变异体，取第一个命中的算子（确定性）', () => {
  assert.equal(mutateLine('  if (a >= 1) {').after, '  if (a > 1) {');
  assert.equal(mutateLine('  return flag === true;').after, '  return flag !== true;');
  assert.equal(mutateLine('  const n = items.length - 0;').after, '  const n = items.length - 1;');
  assert.equal(mutateLine('/// 注释里的 >= 不算').skip, '注释行');
  assert.equal(mutateLine('  foo(bar);').skip, '没有可注入的变异算子');
});

test('applyMutant 在行内容漂移时拒绝改（diff 与工作树不一致）', () => {
  const src = ['export function check(n) {', '  return n >= 2 && n < 9;', '}'].join('\n');
  const m = { file: 'ci/demo.mjs', line: 2, op: 'and-to-or', before: '  return n >= 2 && n < 9;', after: '  return n >= 2 || n < 9;' };
  const ok = applyMutant(src, m);
  assert.equal(ok.ok, true);
  assert.match(ok.text, /\|\|/);
  const drifted = applyMutant(src.replace('n >= 2', 'n > 2'), m);
  assert.equal(drifted.ok, false);
  assert.match(drifted.why, /第 2 行内容与 diff 不一致/);
});

test('probeMutations 跑完无论存活与否都还原文件，并区分 survived/killed/missingTest', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mutate-'));
  try {
    mkdirSync(path.join(dir, 'ci'), { recursive: true });
    const file = path.join(dir, 'ci', 'demo.mjs');
    const original = ['export function check(n) {', '  return n >= 2;', '}'].join('\n');
    writeFileSync(file, original);
    const base = { file: 'ci/demo.mjs', line: 2, op: 'ge-to-gt', before: '  return n >= 2;', after: '  return n > 2;' };
    const drifted = { ...base, before: '  return n > 2;' }; // 与工作树第 2 行不一致

    const survived = await probeMutations({ root: dir, mutants: [base], runTests: () => ({ code: 0 }) });
    assert.equal(survived[0].status, 'survived');
    assert.equal(readFileSync(file, 'utf8'), original, '跑完必须还原文件');

    const killed = await probeMutations({ root: dir, mutants: [base], runTests: () => ({ code: 1 }) });
    assert.equal(killed[0].status, 'killed');
    assert.equal(killed[0].code, 1);

    const noTest = await probeMutations({ root: dir, mutants: [base], runTests: () => ({ missingTest: true }) });
    assert.equal(noTest[0].status, 'survived');

    const timeout = await probeMutations({ root: dir, mutants: [base], runTests: () => ({ timedOut: true }) });
    assert.equal(timeout[0].status, 'killed');
    assert.match(timeout[0].why, /超时/);

    const stale = await probeMutations({ root: dir, mutants: [drifted], runTests: () => ({ code: 0 }) });
    assert.equal(stale[0].status, 'skipped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarize：无可变异行默认只 warn，mutation:strict 才 BLOCKED(exit 3)', () => {
  const plan = { added: 1, mutants: [], skipped: [{ file: 'README.md', line: 1, why: '非代码文件' }] };
  const warn = summarize({ plan });
  assert.equal(warn.code, 0);
  assert.equal(warn.verdict, 'WARN');
  assert.equal(warn.blocked, false);
  const strict = summarize({ plan, strict: true });
  assert.equal(strict.code, 3);
  assert.equal(strict.verdict, 'BLOCKED');
  assert.match(strict.lines[0], /README\.md:1 非代码文件/);
});

test('summarize：有存活变异体只在 strict 下拦，并在输出里点名文件:行', () => {
  const mutant = { file: 'ci/demo.mjs', line: 2, op: 'ge-to-gt', why: '>= 翻成 >' };
  const plan = { added: 1, mutants: [mutant], skipped: [] };
  const results = [{ mutant, status: 'survived', why: '测试仍全绿' }];
  const soft = summarize({ plan, results });
  assert.equal(soft.code, 0);
  assert.equal(soft.survived, 1);
  const hard = summarize({ plan, results, strict: true });
  assert.equal(hard.code, 3);
  assert.equal(hard.blocked, true);
  assert.match(hard.lines[0], /SURVIVED ci\/demo\.mjs:2 ge-to-gt/);
  const clean = summarize({ plan, results: [{ mutant, status: 'killed', code: 1 }], strict: true });
  assert.equal(clean.code, 0);
  assert.equal(clean.killed, 1);
});

test('testPathFor 只按同目录同名约定找受影响测试', () => {
  assert.equal(testPathFor('ci/mutate.mjs'), 'ci/mutate.test.mjs');
  assert.equal(testPathFor('src/ledger.js'), 'src/ledger.test.mjs');
  assert.equal(testPathFor('docs/README.md'), null);
});
