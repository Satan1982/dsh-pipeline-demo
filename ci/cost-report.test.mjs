import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPool, render, summarize } from './cost-report.mjs';

test('池健康段把非 ok 的模型点名列出来', () => {
  const md = renderPool({
    'deepseek-ai/DeepSeek-V4.1-Flash-1017': { status: 'ok', p50Ms: 765, oks24h: 17 },
    'ZhipuAI/GLM-5.2': { status: 'down', p50Ms: 1122, oks24h: 3 },
    'Qwen/Qwen3.8-27B': { status: 'degraded', p50Ms: '', oks24h: 0 },
  });
  assert.match(md, /共 3 个模型，ok 1 个/);
  assert.match(md, /需要留意 2 个/);
  assert.match(md, /ZhipuAI\/GLM-5\.2=down/);
});

test('读不到快照时给出明确说明，而不是空白', () => {
  assert.match(renderPool({}), /读不到 `fm\.py stats` 快照/);
  assert.match(renderPool(null), /读不到/);
});

test('成本报表整篇包含池健康段', () => {
  const sum = summarize(['{"at":"2026-10-27T03:00:00.000Z","issue":1,"attempt":1,"model":"free-pool","paid":false,"cny":0,"totalTokens":1000}']);
  const md = render(sum, { 'A/b': { status: 'ok', p50Ms: 100, oks24h: 2 } });
  assert.match(md, /## 成本报表|# 成本报表/);
  assert.match(md, /## 免费池健康/);
  assert.match(md, /共 1 个模型，ok 1 个/);
});
