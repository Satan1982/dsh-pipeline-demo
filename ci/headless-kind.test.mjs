import test from 'node:test';
import assert from 'node:assert/strict';

import { headlessKind } from './headless-kind.mjs';

test('429 限流不论退出码都归为 llm-rate-limit', () => {
  const out = 'dsh: RATE_LIMIT: 429: {"code":50602,"message":"TPM limit reached"}';
  assert.equal(headlessKind(out, '', 0), 'llm-rate-limit');
  assert.equal(headlessKind('', out, 1), 'llm-rate-limit');
});

test('缺凭证单独一类', () => {
  assert.equal(headlessKind('dsh: MISSING_CREDENTIAL: no API key', '', 1), 'llm-missing-credential');
});

test('agent 自己跑门禁红了单独一类', () => {
  assert.equal(headlessKind('== verify: FAILED ==\n拒绝：测试数量从 40 降到 39', '', 1), 'agent-gate-red');
});

test('什么都没做与未知退出码分开', () => {
  assert.equal(headlessKind('Now I will add the function', '', 0), 'agent-no-change');
  assert.equal(headlessKind('boom', '', 137), 'agent-exit-137');
});

test('分类结果本身是稳定字符串，可直接进指纹库', () => {
  const a = headlessKind('RATE_LIMIT: 429: TPM limit reached', '', 0);
  const b = headlessKind('RATE_LIMIT: 429: TPM limit reached', '', 1);
  assert.equal(a, b);
});

test('Windows NTSTATUS 退出码是进程没起来，不是「什么都没做」', () => {
  // 0xC0000142 = 3221225794，实测并发高峰偶发，重试一次通常就好
  assert.equal(headlessKind('', '', 3221225794), 'headless-crash');
  assert.equal(headlessKind('', '', 0xc000013a), 'headless-crash');
  // 普通退出码不受影响
  assert.equal(headlessKind('', '', 1), 'agent-exit-1');
});
