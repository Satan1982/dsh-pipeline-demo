// ci/llm-proxy.mjs — 一次性 loopback LLM 代理（S4 低权隔离的凭据楔子）。
//
// 目的：低权 agent（dsh-agent）跑 headless 时手里不能有真 key，但云端 provider 必须凭据。
// 调度器（Administrator）在任务期间起一个只绑 127.0.0.1 的代理，持有真 key；agent 拿到的
// patch 指向 http://127.0.0.1:<port>，apiKeyEnv 指向一次性 token。任务结束 proxy.close()，
// token 随之失效。代理不落盘、不记录 key，只记上游状态码。
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';

const HOST = '127.0.0.1';

// upstream：provider 的完整 baseURL（含 /v1，如 https://api-inference.modelscope.cn/v1）。
// openai-completions 客户端会请求 /v1/chat/completions；这里剥掉开头的 /v1 再拼到 upstream，
// 避免 baseURL 已带 /v1 时出现 /v1/v1。
export function startLlmProxy({ upstream, apiKey, log = () => {} } = {}) {
  if (!upstream) throw new Error('缺少 upstream baseURL');
  if (!apiKey) throw new Error('缺少上游 apiKey');
  const token = randomBytes(24).toString('hex');
  // 上游状态码留痕：调度器据此把「429 限流」与「agent 写错了」分开（429 只等重试，不挂起）。
  let lastUpstreamStatus = 0;
  const recordStatus = (code) => { lastUpstreamStatus = code; };
  const upstreamBase = upstream.replace(/\/+$/, '');
  const upstreamP = new URL(upstreamBase);
  const requestImpl = upstreamP.protocol === 'https:' ? httpsRequest : httpRequest;

  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid proxy token', type: 'auth_error' } }));
      return;
    }
    const rawPath = req.url || '/';
    const path = rawPath.startsWith('/v1/') ? rawPath.slice(3) : rawPath;
    let target;
    try {
      target = new URL(upstreamBase + path);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad upstream path' } }));
      return;
    }
    const headers = { ...req.headers, host: target.host, authorization: `Bearer ${apiKey}` };
    const up = requestImpl(target, { method: req.method, headers }, (ur) => {
      const code = ur.statusCode ?? 502;
      recordStatus(code);
      res.writeHead(code, ur.headers);
      ur.pipe(res);
      if (code >= 400) log(`[proxy] upstream ${code} ${path}`);
    });
    up.on('error', (e) => {
      log(`[proxy] upstream error ${e.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'proxy upstream unreachable' } }));
    });
    req.pipe(up);
    req.on('aborted', () => up.destroy());
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const port = server.address().port;
      resolve({
        port,
        token,
        baseURL: `http://${HOST}:${port}`,
        upstreamStatus: () => lastUpstreamStatus,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
