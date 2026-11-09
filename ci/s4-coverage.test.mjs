// ci/s4-coverage.test.mjs — `--status` 的 S4 覆盖率行（docs/security-remediation-20261109.md §七 闸门 3）。
//
// 判据（缺一不可）：
// ① 审计只认 s4=true 的记录是「低权执行」；失败但走了通道的记录不能算回退；
// ② 只有显式 DSH_S4_FALLBACK=admin 留下的 s4-fallback 事件才算回退，出现一次闸门就不成立；
// ③ 0 次执行时不能说「覆盖 100%」（那是没测过，不是覆盖率）；
// ④ 损坏的半行不能打死体检（审计是旁路）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { countFallbackEvents, formatS4Coverage, parseAudit, summarizeS4Coverage } from './s4-coverage.mjs';

const rec = (s4, ok = true) => ({ ts: '2026-11-09T00:00:00Z', actor: 'drill', s4, ok });
const ev = (kind) => ({ ts: '2026-11-09T00:00:00Z', kind, why: 'x' });

test('parseAudit 跳过损坏行，不丢好行', () => {
  const rows = parseAudit(`${JSON.stringify(rec(true))}\n{broken\n\n${JSON.stringify(rec(false))}\n`);
  assert.equal(rows.length, 2);
});

test('全部走低权：覆盖 100%，ok=true', () => {
  const s = summarizeS4Coverage({ audit: [rec(true), rec(true, false)] });
  assert.equal(s.ok, true);
  assert.equal(s.attempts, 2);
  assert.equal(s.lowPriv, 2, '命令失败但走了低权通道的也算低权执行');
  assert.equal(s.succeeded, 1, '成功只数 ok=true 的记录');
  assert.equal(s.ratePct, 100);
  assert.match(formatS4Coverage(s), /覆盖 100%.*0 次回退/);
});

test('出现回退事件：闸门 3 不成立，且写明回退次数', () => {
  const s = summarizeS4Coverage({ audit: [rec(true)], fallbackEvents: 1 });
  assert.equal(s.ok, false);
  assert.equal(s.ratePct, 50);
  assert.match(formatS4Coverage(s), /⚠ 1 次回退/);
});

test('0 次执行时不能说 100%（没测过）', () => {
  const s = summarizeS4Coverage({ audit: [] });
  assert.equal(s.ok, true);
  assert.equal(s.ratePct, null);
  assert.match(formatS4Coverage(s), /覆盖 n\/a/);
});

test('countFallbackEvents 只数 s4-fallback', () => {
  const text = [ev('failed'), ev('s4-fallback'), ev('s4-fallback'), ev('pool')].map(JSON.stringify).join('\n');
  assert.equal(countFallbackEvents(text), 2);
});
