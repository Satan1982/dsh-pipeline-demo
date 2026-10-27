import test from 'node:test';
import assert from 'node:assert/strict';
import { costCny, formatCny, isPeak, priceFor } from './prices.mjs';

const idle = new Date('2026-10-27T10:00:00+08:00'); // 周二 10:00 → 高峰
const off = new Date('2026-10-27T22:00:00+08:00');  // 周二 22:00 → 空闲

test('高峰判断按北京时间工作日 9-12 / 14-18', () => {
  assert.equal(isPeak(idle), true);
  assert.equal(isPeak(off), false);
  assert.equal(isPeak(new Date('2026-10-31T10:00:00+08:00')), false); // 周六
});

test('deepseek-flash 空闲价 1/4 元每百万，高峰翻倍', () => {
  const u = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.equal(costCny(u, 'deepseek-flash', off), 5);
  assert.equal(costCny(u, 'deepseek-flash', idle), 10);
  assert.equal(priceFor('deepseek-flash', idle).peak, true);
});

test('免费池按 0 计，未知模型返回 null 并显示为问号', () => {
  const u = { inputTokens: 300_000, outputTokens: 20_000 };
  assert.equal(costCny(u, 'deepseek-ai/DeepSeek-V4.1-Flash-1017', off), 0);
  assert.equal(costCny(u, 'no-such-model', off), null);
  assert.equal(formatCny(0), '¥0');
  assert.match(formatCny(null), /价目表/);
});

test('小额显示四位小数，够大显示两位', () => {
  assert.equal(formatCny(0.00234), '¥0.0023');
  assert.equal(formatCny(1.234), '¥1.23');
});
