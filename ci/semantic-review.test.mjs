import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseVerdict,
  buildReviewPrompt,
  formatSemantic,
  readCredential,
  reviewSemantically,
  aggregateReviewers,
  reviewWithPanel,
  panelModels,
} from './semantic-review.mjs';

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

test('提示词里带调度器已跑过的验收命令，且允许「实现已存在」', () => {
  const p = buildReviewPrompt({
    issueNumber: 8, title: 't', goal: 'g', acceptance: 'a', diffText: '+x', files: [],
    acceptanceNote: '调度器已在本 worktree 里执行过验收命令，全部 exit 0：\n```\nnode -e "0"\n```',
  });
  assert.match(p, /调度器已经跑过的验收命令/);
  assert.match(p, /全部 exit 0/);
  assert.match(p, /已经被之前的合并实现/);
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

test('评审团聚合：任一模型 block 就是 block（保守）', () => {
  const merged = aggregateReviewers([
    { model: 'a', verdict: 'pass', findings: [{ severity: 'warn', rule: 'semantic', message: '风格偏长' }] },
    { model: 'b', verdict: 'block', findings: [{ severity: 'block', rule: 'semantic', message: '没实现验收要求' }] },
  ]);
  assert.equal(merged.verdict, 'block');
  assert.equal(merged.ok, false);
  assert.equal(merged.findings.length, 2);
});

test('评审团聚合：两个都 pass 才算 pass，全跳过才是跳过', () => {
  const pass = aggregateReviewers([
    { model: 'a', verdict: 'pass', findings: [] },
    { model: 'b', verdict: 'pass', findings: [] },
  ]);
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.ok, true);

  const skipped = aggregateReviewers([
    { model: 'a', verdict: 'skipped', skipped: '超时' },
    { model: 'b', verdict: 'skipped', skipped: '没有凭证' },
  ]);
  assert.equal(skipped.verdict, 'skipped');
  assert.match(skipped.skipped, /超时/);
});

test('评审团聚合：一个跳过、一个 pass 仍算 pass（不当成没评审）', () => {
  const merged = aggregateReviewers([
    { model: 'a', verdict: 'skipped', skipped: '超时' },
    { model: 'b', verdict: 'pass', findings: [] },
  ]);
  assert.equal(merged.verdict, 'pass');
  assert.equal(merged.ok, true);
});

test('reviewWithPanel 逐个模型取自己的 mock，并把每个结论记在 reviewers 里', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'panel-'));
  const okFile = path.join(dir, 'ok.json');
  const badFile = path.join(dir, 'bad.json');
  writeFileSync(okFile, JSON.stringify({ verdict: 'pass', findings: [] }));
  writeFileSync(badFile, JSON.stringify({ verdict: 'block', findings: [{ severity: 'block', file: 'src/x.js', message: '缺少边界处理' }] }));

  const merged = await reviewWithPanel({
    goal: '加一个函数',
    acceptance: '函数返回 1',
    diffText: 'diff content',
    models: ['m-ok', 'm-bad'],
    mockPaths: [okFile, badFile],
  });
  assert.equal(merged.verdict, 'block');
  assert.equal(merged.reviewers.length, 2);
  assert.deepEqual(merged.reviewers.map((r) => r.model), ['m-ok', 'm-bad']);
  assert.match(formatSemantic(merged), /评审团 2\/2 有效/);
  assert.match(formatSemantic(merged), /m-bad=block/);
});

test('panelModels 默认两个不同家族，可用环境变量覆盖', () => {
  assert.equal(panelModels('').length, 2);
  assert.deepEqual(panelModels('x/y, z/w'), ['x/y', 'z/w']);
});
