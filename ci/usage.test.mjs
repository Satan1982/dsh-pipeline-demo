import test from 'node:test';
import assert from 'node:assert/strict';

import { sumUsage, formatUsage, finalText, sessionIdOf } from './usage.mjs';

const ev = (o) => JSON.stringify(o);

test('累加每一步的 usage', () => {
  const out = [
    ev({ type: 'status', phase: 'step_end', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }),
    'garbage line',
    ev({ type: 'status', phase: 'step_end', usage: { inputTokens: 50, outputTokens: 5 } }),
    ev({ type: 'final', text: 'done' }),
  ].join('\n');
  const u = sumUsage(out);
  assert.equal(u.inputTokens, 150);
  assert.equal(u.outputTokens, 25);
  assert.equal(u.totalTokens, 175);
  assert.equal(u.steps, 2);
});

test('没有 usage 的事件流返回全 0', () => {
  const u = sumUsage([ev({ type: 'text', text: 'hi' }), ev({ type: 'final', text: 'hi' })].join('\n'));
  assert.deepEqual(u, { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 0 });
  assert.match(formatUsage(u), /统计不到/);
});

test('格式化成一句话，便于写进日志与 PR', () => {
  const s = formatUsage({ inputTokens: 21013, outputTokens: 69, totalTokens: 21082, steps: 1 });
  assert.equal(s, '21082 tokens（in 21013 / out 69，1 步）');
});

test('finalText 取 final 事件，取不到就拼 text 事件', () => {
  assert.equal(finalText([ev({ type: 'final', text: '答案是 42' })].join('\n')), '答案是 42');
  assert.equal(finalText([ev({ type: 'text', text: 'a' }), ev({ type: 'text', text: 'b' })].join('\n')), 'ab');
});

test('空输入不抛错', () => {
  assert.equal(sumUsage('').steps, 0);
  assert.equal(finalText(''), '');
});

test("从事件流里取 sessionId", () => {
  const nd = [
    JSON.stringify({ type: "session", sessionId: "session-abc", cwd: "x" }),
    JSON.stringify({ type: "final", text: "ok" }),
  ].join("\n");
  assert.equal(sessionIdOf(nd), "session-abc");
  assert.equal(sessionIdOf(""), "");
  assert.equal(sessionIdOf(JSON.stringify({ type: "final", text: "ok" })), "");
});
