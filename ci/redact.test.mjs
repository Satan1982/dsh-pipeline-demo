// 公开出口脱敏的判据（issue #242 / P1-7）。
// 断言分两类：必须打码（凭据、绝对路径）与必须保留（相对路径、sha、VERDICT）。
// 夹具里的 token 用字符串拼接，避免仓库里出现可被扫描器命中的完整形状。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  redactPublic,
  redactPublicPayload,
  isPublicWritePath,
  PUBLIC_TEXT_LIMIT,
} from './redact.mjs';

const GH = 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123';
const SK = 's' + 'k-' + 'proj-abcdefghijklmnopqrstuv';
const BEARER = 'Bearer ' + 'abcdefghijklmnopqrstu';
const JWT = ['e' + 'yJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');

test('绝对路径：盘符路径整体打码，评论里不残留 .secrets', () => {
  const out = redactPublic('读取 D:\\code\\.secrets\\github-token.txt 被拒');
  assert.ok(!out.includes('.secrets'), out);
  assert.ok(!out.includes('D:\\'), out);
  assert.ok(out.includes('读取'), out);
});

test('绝对路径：UNC 与 MSYS / POSIX 路径也打码', () => {
  const unc = redactPublic('看 \\\\nas01\\share\\a.txt');
  assert.ok(!unc.includes('share'), unc);
  const msys = redactPublic('cwd=/d/code/.secrets 下');
  assert.ok(!msys.includes('.secrets'), msys);
  const posix = redactPublic('log at /home/runner/work/x/y');
  assert.ok(!posix.includes('/home/runner'), posix);
});

test('URL 里的 /home 片段不被误伤', () => {
  const out = redactPublic('见 https://example.com/home/page 说明');
  assert.equal(out, '见 https://example.com/home/page 说明');
});

test('凭据形状打码：gh token / sk / Bearer / JWT / 私钥块', () => {
  assert.ok(!redactPublic('token ' + GH + ' x').includes(GH));
  assert.ok(!redactPublic('key ' + SK + ' x').includes(SK));
  const b = redactPublic('Authorization: ' + BEARER);
  assert.ok(!b.includes('abcdefghijklmnopqrstu'), b);
  assert.ok(!redactPublic('jwt ' + JWT).includes(JWT));
  // 私钥块的两种头尾拼接着写：整块字面量会被仓库的凭据扫描拦下（也真不该进仓库）。
  const pem = ['-----BEGIN', 'RSA PRIVATE', 'KEY-----', 'MIIEow', '-----END', 'RSA PRIVATE', 'KEY-----'].join(' ');
  const out = redactPublic('key: ' + pem);
  assert.ok(!out.includes('MIIEow'), out);
});

test('排障信息保留：相对路径、sha、VERDICT 行不被改写', () => {
  const text = 'ci/dispatch.mjs:476 已改；commit 16ca27b；VERDICT: PASS';
  assert.equal(redactPublic(text), text);
});

test('幂等：对已脱敏文本再跑一次不变化', () => {
  const once = redactPublic('读 D:\\code\\.secrets\\x 和 ' + GH);
  assert.equal(redactPublic(once), once);
});

test('超长输出截断并写明原长', () => {
  const long = 'a'.repeat(PUBLIC_TEXT_LIMIT + 500);
  const out = redactPublic(long);
  assert.ok(out.length < long.length, 'must be shorter');
  assert.ok(out.includes('已截断'), out.slice(-80));
  assert.ok(out.includes(String(long.length)), out.slice(-80));
});

test('自定义 limit 生效；非字符串原样返回', () => {
  assert.ok(redactPublic('abcdef', { limit: 3 }).startsWith('abc'));
  assert.equal(redactPublic(undefined), undefined);
  assert.equal(redactPublic(null), null);
  assert.equal(redactPublic(''), '');
});

test('payload：只改 POST comments / pulls 的 body 字段', () => {
  const body = { body: '读 D:\\code\\.secrets\\x', extra: 'keep' };
  const c = redactPublicPayload('POST', '/repos/a/b/issues/1/comments', body);
  assert.ok(!c.body.includes('.secrets'), c.body);
  assert.equal(c.extra, 'keep');
  const pr = redactPublicPayload('POST', '/repos/a/b/pulls', body);
  assert.ok(!pr.body.includes('.secrets'), pr.body);
});

test('payload：label / GET / 非 body 字段原样（引用相等）', () => {
  const labels = { labels: ['agent:ready'] };
  assert.equal(redactPublicPayload('POST', '/repos/a/b/issues/1/labels', labels), labels);
  const comment = { body: 'D:\\code\\.secrets' };
  assert.equal(redactPublicPayload('GET', '/repos/a/b/issues/1/comments', comment), comment);
  const odd = { title: 'D:\\code\\.secrets' };
  assert.equal(redactPublicPayload('POST', '/repos/a/b/pulls', odd), odd);
});

test('isPublicWritePath 只认 comments / pulls 结尾', () => {
  assert.equal(isPublicWritePath('/repos/a/b/issues/1/comments'), true);
  assert.equal(isPublicWritePath('/repos/a/b/pulls'), true);
  assert.equal(isPublicWritePath('/repos/a/b/pulls/9'), false);
  assert.equal(isPublicWritePath('/repos/a/b/issues/1/labels'), false);
  assert.equal(isPublicWritePath('/repos/a/b/issues/1/comments?per_page=100'), false);
});
