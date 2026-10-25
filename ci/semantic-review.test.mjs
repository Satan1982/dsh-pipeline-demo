import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseVerdict, buildReviewPrompt, formatSemantic, readCredential, reviewSemantically } from './semantic-review.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'sem-review-'));

test('pass 结论解析为通过', () => {
  const r = parseVerdict('{"verdict":"pass","findings":[]}');
  assert.equal(r.verdict, 'pass');
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 0);
});

test('block 结论带出具体缺什么', () => {
  const r = parseVerdict('{"verdict":"block","findings":[{"severity":"block","file":"src/x.js","message":"缺少空输入返回 \\"\\" 的用例"}]}');
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'block');
  assert.equal(r.findings[0].file, 'src/x.js');
  assert.match(r.findings[0].message, /空输入/);
});

test('非 JSON 输出按 block 处理（fail closed）', () => {
  const r = parseVerdict('我觉得写得挺好的，可以合并');
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'block');
  assert.equal(r.findings[0].rule, 'semantic-unparseable');
});

test('缺少 verdict 的 JSON 按 block 处理', () => {
  const r = parseVerdict('{"findings":[]}');
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'block');
});

test('verdict=pass 但带 block finding 时以更严格的为准', () => {
  const r = parseVerdict('{"verdict":"pass","findings":[{"severity":"block","message":"RangeError 没抛"}]}');
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'block');
});

test('提示词里带验收标准与实际 diff', () => {
  const p = buildReviewPrompt({
    issueNumber: 42, title: 'Add reverseWords', goal: '反转单词顺序',
    acceptance: '- reverseWords("") 返回 ""', constraints: '只改两个文件', diffText: '+export function reverseWords(s) {}',
  });
  assert.match(p, /#42/);
  assert.match(p, /reverseWords\(""\) 返回 ""/);
  assert.match(p, /\+export function reverseWords/);
  assert.match(p, /"verdict":"pass"\|"block"/);
});

test('提示词里带改动文件清单，并禁止否认清单内的文件', () => {
  const p = buildReviewPrompt({
    issueNumber: 7, title: 't', goal: 'g', acceptance: 'a', diffText: '+x',
    files: [{ status: 'M', path: 'src/index.js' }],
  });
  assert.match(p, /- M {2}src\/index\.js/);
  assert.match(p, /不要声称它没被修改/);
});

test('mock 文件可以强制 block，且不调用网络', async () => {
  const dir = tmp();
  const mock = path.join(dir, 'verdict.json');
  writeFileSync(mock, '{"verdict":"block","findings":[{"severity":"block","message":"验收第 3 条没做"}]}');
  const r = await reviewSemantically({
    goal: 'x', acceptance: 'y', diffText: '+a', mockPath: mock, credential: '',
  });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'block');
  assert.match(r.model, /^mock:/);
});

test('没有凭证时跳过而不是阻断', async () => {
  const r = await reviewSemantically({ goal: 'x', acceptance: 'y', diffText: '+a', credential: '', mockPath: '' });
  assert.equal(r.verdict, 'skipped');
  assert.equal(r.ok, true);
  assert.match(formatSemantic(r), /跳过/);
});

test('凭证文件按 refs 里的键名取值', () => {
  const dir = tmp();
  const file = path.join(dir, 'creds.yaml');
  const key = ['SILICONFLOW', 'API', 'KEY'].join('_');
  writeFileSync(file, `refs:\n  OTHER: x\n  ${key}: fake-value-for-test\n  LAST: y\n`);
  assert.equal(readCredential(file), 'fake-value-for-test');
  assert.equal(readCredential(path.join(dir, 'missing.yaml')), '');
});
