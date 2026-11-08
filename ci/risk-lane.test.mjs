// ci/risk-lane.test.mjs —— v3 P1（docs/89 §3.4）：lane 标签判定 + unknown-rate 统计。
// 放在 ci/ 顶层：verify.sh 的测试清单只 glob `ci/*.test.mjs`。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HIGH_RISK_LABEL,
  LANE,
  LANE_LABELS,
  UNKNOWN_RATE_TARGET,
  UNKNOWN_RATE_WINDOW,
  formatLaneLine,
  lanePolicy,
  laneStats,
  loadLaneStats,
  parseLane,
  recordLane,
} from './risk-lane.mjs';

test('lane 标签齐全且无冲突时按声明解析', () => {
  assert.deepEqual(parseLane(['lane:docs']).lane, LANE.docs);
  assert.equal(parseLane(['lane:docs']).unknown, false);
  assert.equal(parseLane(['lane:standard']).lane, LANE.standard);
  assert.equal(parseLane([{ name: 'lane:high-risk' }]).lane, LANE.highRisk);
  assert.equal(LANE_LABELS.length, 3);
});

test('缺标签 / 冲突 / 写错名字一律 high-risk + unknown（fail-closed）', () => {
  const missing = parseLane([]);
  assert.equal(missing.lane, LANE.highRisk);
  assert.equal(missing.unknown, true);
  assert.match(missing.why, /缺少/);

  const conflict = parseLane(['lane:docs', 'lane:standard']);
  assert.equal(conflict.lane, LANE.highRisk);
  assert.equal(conflict.unknown, true);

  // 写错名字（lane:low）不是合法 lane，等价于没写。
  const typo = parseLane(['lane:low']);
  assert.equal(typo.lane, LANE.highRisk);
  assert.equal(typo.unknown, true);
  assert.equal(typo.declared, null);
});

test('tier 固定：docs=T1 standard=T2 high-risk=T3', () => {
  assert.equal(lanePolicy(LANE.docs).tier, 1);
  assert.equal(lanePolicy(LANE.standard).tier, 2);
  assert.equal(lanePolicy(LANE.highRisk).tier, 3);
  // 传进来任何非法值都按 high-risk，绝不下调。
  assert.equal(lanePolicy('unknown').tier, 3);
  assert.equal(lanePolicy('').tier, 3);
});

test('high-risk 不吃 acceptance:optional 豁免且强制 strict', () => {
  const high = lanePolicy(LANE.highRisk);
  assert.equal(high.allowOptionalAcceptance, false);
  assert.equal(high.forceStrictVerdict, true);
  assert.equal(high.requireAcceptance, true);
  assert.equal(lanePolicy(LANE.standard).allowOptionalAcceptance, true);
  assert.equal(lanePolicy(LANE.standard).forceStrictVerdict, false);
});

test('unknown-rate 只按最后 window 条统计', () => {
  const recs = [{ unknown: true }, { unknown: false }, { unknown: false }, { unknown: false }];
  const s = laneStats(recs);
  assert.equal(s.n, 4);
  assert.equal(s.unknown, 1);
  assert.equal(s.rate, 0.25);
  assert.equal(s.target, UNKNOWN_RATE_TARGET);
  assert.equal(laneStats([]).rate, 0);
  assert.equal(UNKNOWN_RATE_WINDOW, 100);
});

test('recordLane 落 JSONL，loadLaneStats 只读回最后 window 条', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lane-stats-'));
  try {
    const file = path.join(dir, 'lane-stats.jsonl');
    assert.equal(recordLane(file, { lane: 'docs', unknown: false }), true);
    assert.equal(recordLane(file, { lane: 'high-risk', unknown: true }), true);
    const loaded = loadLaneStats(file);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[1].unknown, true);
    assert.ok(loaded[0].at, '记录必须带时间戳');
    assert.equal(loadLaneStats(file, 1).length, 1);
    // 坏行跳过，不炸整次调度。
    const broken = path.join(dir, 'broken.jsonl');
    recordLane(broken, { lane: 'docs' });
    assert.deepEqual(loadLaneStats(path.join(dir, 'none.jsonl')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatLaneLine 标出 unknown 与超目标状态', () => {
  const line = formatLaneLine(parseLane([]), { n: 10, unknown: 2, rate: 0.2 });
  assert.match(line, /tier=T3/);
  assert.match(line, /unknown→high-risk/);
  assert.match(line, /20\.0%/);
  assert.match(line, /超过目标/);
  assert.match(line, /lane:high-risk|high-risk/);
  assert.equal(HIGH_RISK_LABEL, 'lane:high-risk');
});
