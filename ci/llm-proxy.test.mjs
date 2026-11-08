import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startLlmProxy } from './llm-proxy.mjs';

function fakeUpstream() {
  return new Promise((resolve) => {
    const seen = [];
    const srv = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }));
  });
}

test('代理：正确 token 转发到上游，路径不重复 /v1，key 换成真 key', async () => {
  const up = await fakeUpstream();
  const proxy = await startLlmProxy({ upstream: `http://127.0.0.1:${up.port}/v1`, apiKey: 'test' });
  try {
    const res = await fetch(`${proxy.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.url, '/v1/chat/completions');
    assert.equal(up.seen.length, 1);
    assert.equal(up.seen[0].auth, 'Bearer test');
  } finally {
    await proxy.close();
    await up.close();
  }
});

test('代理：错误 token 返回 401，且不触达上游', async () => {
  const up = await fakeUpstream();
  const proxy = await startLlmProxy({ upstream: `http://127.0.0.1:${up.port}/v1`, apiKey: 'test' });
  try {
    const res = await fetch(`${proxy.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 401);
    assert.equal(up.seen.length, 0);
  } finally {
    await proxy.close();
    await up.close();
  }
});

test('代理：close 后端口不再接受连接', async () => {
  const up = await fakeUpstream();
  const proxy = await startLlmProxy({ upstream: `http://127.0.0.1:${up.port}/v1`, apiKey: 'test' });
  await proxy.close();
  await up.close();
  await assert.rejects(
    fetch(`${proxy.baseURL}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(3000) }),
  );
});

test('代理：上游 5xx 原样回传并记日志', async () => {
  const srv = createServer((_req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"rate"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const logs = [];
  const proxy = await startLlmProxy({ upstream: `http://127.0.0.1:${srv.address().port}/v1`, apiKey: 'k', log: (m) => logs.push(m) });
  try {
    const res = await fetch(`${proxy.baseURL}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${proxy.token}` }, body: '{}', signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 429);
    assert.match(logs.join('\n'), /upstream 429/);
  } finally {
    await proxy.close();
    await new Promise((r) => srv.close(r));
  }
});
