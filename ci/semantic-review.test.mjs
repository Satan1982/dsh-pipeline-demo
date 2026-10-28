import test from 'node:test';
import assert from 'node:assert/strict';

// 测试必须与真实凭据隔离：否则本机 .credentials.yaml 里的 key 会被读到，
// 「没有凭证就 skipped」那条会真的去发网络请求（2026-10-27 加免费池 key 后踩过）。
process.env.DSH_CREDENTIALS = 'D:/nonexistent-test-secrets/.credentials.yaml';
delete process.env.MODELSCOPE_API_TOKEN;
delete process.env.SILICONFLOW_API_KEY;
delete process.env.ZHIPU_API_KEY;
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
  FREE_REVIEW_MODEL,
  pickFreeModels,
  flattenStats,
  FREE_STRONG_MODELS,
  statsExpired,
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

test('评审团聚合：两个都 pass 才算 pass，全跳过是「缺失」不是 pass', () => {
  const pass = aggregateReviewers([
    { model: 'a', verdict: 'pass', findings: [] },
    { model: 'b', verdict: 'pass', findings: [] },
  ]);
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.ok, true);

  // 2026-10-28 架构评审 P0-1：全跳过 = 这一层不存在，不能当 pass 放行。
  const missing = aggregateReviewers([
    { model: 'a', verdict: 'skipped', skipped: '超时' },
    { model: 'b', verdict: 'skipped', skipped: '没有凭证' },
  ]);
  assert.equal(missing.verdict, 'missing');
  assert.equal(missing.ok, false);
  assert.match(missing.skipped, /超时/);
  assert.match(formatSemantic(missing), /评审缺失/);
});

test('评审团聚合：面板凑不够 minValid 家时 pass 但要人工复核', () => {
  const partial = aggregateReviewers([
    { model: 'a', verdict: 'pass', findings: [] },
    { model: 'b', verdict: 'skipped', skipped: '限流' },
  ], { minValid: 2 });
  assert.equal(partial.verdict, 'pass');
  assert.equal(partial.ok, true);
  assert.equal(partial.valid, 1);
  assert.equal(partial.degraded, 'panel-partial');
  assert.equal(partial.needsHuman, true);
  assert.match(formatSemantic(partial), /需人工复核/);
});

test('评审团聚合：免费档单模型标 free-single，但不升级为需人工', () => {
  const single = aggregateReviewers([{ model: 'x', verdict: 'pass', findings: [] }], { minValid: 1, single: true });
  assert.equal(single.ok, true);
  assert.equal(single.degraded, 'free-single');
  assert.equal(single.needsHuman, undefined);
  assert.match(formatSemantic(single), /单模型免费档/);
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
    skipFree: true,
    credential: '',
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

test('免费档能出结论时就不花一分钱', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'panel-free-'));
  const okFile = path.join(dir, 'ok.json');
  writeFileSync(okFile, JSON.stringify({ verdict: 'pass', findings: [] }));

  const merged = await reviewWithPanel({
    goal: '加一个函数',
    acceptance: '函数返回 1',
    diffText: 'diff content',
    mockPath: okFile,
    credential: '',
  });
  assert.equal(merged.tier, 'free');
  assert.equal(merged.paidUsed, false);
  assert.equal(merged.verdict, 'pass');
  assert.equal(merged.model, FREE_REVIEW_MODEL);
  assert.equal(merged.reviewers.length, 1);
  assert.equal(merged.reviewers[0].tier, 'free');
});

test('免费档不可用时切付费面板，并把原因带出来（用于告知）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'panel-paid-'));
  const okFile = path.join(dir, 'ok.json');
  writeFileSync(okFile, JSON.stringify({ verdict: 'pass', findings: [] }));

  // 没有凭证 ⇒ 免费档 skipped；面板走 mock（panel 分支在读凭证之前返回）。
  const merged = await reviewWithPanel({
    goal: '加一个函数',
    acceptance: '函数返回 1',
    diffText: 'diff content',
    models: ['m1', 'm2'],
    mockPaths: [okFile, okFile],
    credential: '',
  });
  assert.equal(merged.tier, 'paid');
  assert.equal(merged.paidUsed, true);
  assert.equal(merged.freeModel, FREE_REVIEW_MODEL);
  assert.match(merged.escalatedFrom, /凭证/);
  assert.equal(merged.verdict, 'pass');
  assert.match(formatSemantic(merged), /\[付费\]/);
});

test('免费档回了非 JSON（给不出裁决）也按不可用处理，切付费面板', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'panel-garbage-'));
  const junk = path.join(dir, 'junk.txt');
  const ok = path.join(dir, 'ok.json');
  writeFileSync(junk, '这段代码看起来不错，可以合并。');
  writeFileSync(ok, JSON.stringify({ verdict: 'pass', findings: [] }));

  const merged = await reviewWithPanel({
    goal: 'g',
    acceptance: 'a',
    diffText: 'd',
    mockPath: junk,
    models: ['m1', 'm2'],
    mockPaths: [ok, ok],
    credential: '',
  });
  assert.equal(merged.paidUsed, true);
  assert.equal(merged.verdict, 'pass');
  assert.match(merged.escalatedFrom, /没有按格式返回 JSON/);
});

test('按免费池健康快照挑模型：ok 优先，down 垫底', () => {
  const stats = {
    'deepseek-ai/DeepSeek-V4.1-Flash-1017': { status: 'down' },
    'ZhipuAI/GLM-5.2': { status: 'ok' },
    'Qwen/Qwen3.8-27B': { status: 'ok' },
  };
  assert.deepEqual(pickFreeModels(stats, FREE_STRONG_MODELS, 2), ['ZhipuAI/GLM-5.2', 'Qwen/Qwen3.8-27B']);
  assert.deepEqual(pickFreeModels({}, FREE_STRONG_MODELS, 1), ['deepseek-ai/DeepSeek-V4.1-Flash-1017']);
});

test('flattenStats 把「规范名 + models 列表」摊平成模型 id', () => {
  const flat = flattenStats({ 'deepseek-v4.1-flash': { status: 'ok', models: ['deepseek-ai/DeepSeek-V4.1-Flash-1017'] } });
  assert.equal(flat['deepseek-v4.1-flash'].status, 'ok');
  assert.equal(flat['deepseek-ai/DeepSeek-V4.1-Flash-1017'].status, 'ok');
});

test('免费池快照缓存按 TTL 过期（默认 10 分钟）', () => {
  const now = 1_000_000_000;
  assert.equal(statsExpired(0, now), true, '没抓过就算过期');
  assert.equal(statsExpired(now - 60_000, now), false, '1 分钟前抓的还有效');
  assert.equal(statsExpired(now - 10 * 60 * 1000, now), true, '正好 10 分钟算过期');
  assert.equal(statsExpired(now - 9 * 60 * 1000, now, 5 * 60 * 1000), true, 'TTL 可覆盖');
});
