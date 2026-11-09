import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  MAX_LIMIT,
  WINDOW_DAYS,
  dailyStats,
  parseSnapshots,
  poolTrend,
  readPoolSnapshot,
  renderPoolTrend,
  tailLines,
  windowDays,
} from './pool-trend.mjs';

const H = 3600 * 1000;
const base = Date.UTC(2026, 10, 1, 0, 0, 0); // 2026-11-01T00:00Z

function snap(hoursAgo, ok, extra = {}) {
  return JSON.stringify({ at: new Date(base + (24 - hoursAgo) * H).toISOString(), ok, ...extra });
}

test('parseSnapshots：坏行只计数，好行照收（时间接受 ISO / 毫秒 / 秒）', () => {
  const text = [
    JSON.stringify({ at: '2026-11-01T00:00:00.000Z', ok: 10 }),
    '{坏行',
    JSON.stringify({ at: base + 1000, ok: '12' }),
    JSON.stringify({ at: Math.floor((base + 2000) / 1000), ok: 14 }),
    JSON.stringify({ at: '2026-11-01T00:00:03.000Z', ok: null }),
    JSON.stringify({ ok: 9 }),
    JSON.stringify({ at: '1970-01-01T00:00:00.000Z', ok: 9 }),
    '',
    '   ',
  ].join('\n');
  const { records, bad } = parseSnapshots(text);
  assert.equal(records.length, 3);
  assert.equal(bad, 4);
  assert.equal(records[1].ok, 12);
  assert.equal(records[1].total, null);
});

test('parseSnapshots：数字字段保留 null，不把 undefined 当 0', () => {
  const { records } = parseSnapshots(JSON.stringify({ at: '2026-11-01T00:00:00Z', ok: 5, stale: 0 }));
  assert.equal(records[0].stale, 0);
  assert.equal(records[0].down, null);
});

test('dailyStats：按 UTC 日分组并取中位', () => {
  const { records } = parseSnapshots(
    [
      JSON.stringify({ at: '2026-11-01T00:00:00Z', ok: 10 }),
      JSON.stringify({ at: '2026-11-01T23:00:00Z', ok: 30 }),
      JSON.stringify({ at: '2026-11-01T12:00:00Z', ok: 20 }),
      JSON.stringify({ at: '2026-11-02T01:00:00Z', ok: 40 }),
    ].join('\n'),
  );
  const days = dailyStats(records);
  assert.equal(days.length, 2);
  assert.equal(days[0].date, '2026-11-01');
  assert.equal(days[0].count, 3);
  assert.equal(days[0].medianOk, 20);
  assert.equal(days[0].minOk, 10);
  assert.equal(days[0].maxOk, 30);
  assert.equal(days[0].last.ok, 30);
  assert.equal(days[1].medianOk, 40);
});

test('poolTrend：时间窗按天截断，不受行数影响', () => {
  const rows = [];
  // 30 天，每天 1 行 00:00；只看近 14 天（锚在 d=29 00:00，窗口从 d=15 00:00 起）
  for (let d = 0; d < 30; d += 1) {
    const ms = Date.UTC(2026, 9, 1 + d, 0);
    rows.push({ at: new Date(ms).toISOString(), atMs: ms, ok: d + 1 });
  }
  const t = poolTrend(rows, { days: 14 });
  assert.equal(t.days, 14);
  assert.equal(t.coveredDays, 14);
  assert.equal(t.count, 14);
  assert.equal(t.firstDayMedian, 17); // 窗口首日 d=16 → ok=17
});

test('poolTrend：首日与最新一日的中位差给出口径，同数据乱序结果一致', () => {
  const rows = [
    { at: '2026-11-01T00:00:00Z', atMs: Date.UTC(2026, 10, 1, 0), ok: 90 },
    { at: '2026-11-01T12:00:00Z', atMs: Date.UTC(2026, 10, 1, 12), ok: 92 },
    { at: '2026-11-05T00:00:00Z', atMs: Date.UTC(2026, 10, 5, 0), ok: 20 },
    { at: '2026-11-05T12:00:00Z', atMs: Date.UTC(2026, 10, 5, 12), ok: 24 },
    { at: '2026-11-05T13:00:00Z', atMs: Date.UTC(2026, 10, 5, 13), ok: 97, total: 158 },
  ];
  const a = poolTrend(rows);
  const b = poolTrend(rows.slice().reverse());
  assert.equal(a.firstDayMedian, 91);
  assert.equal(a.lastDayMedian, 24);
  assert.equal(a.delta, -67);
  assert.equal(a.total, 158);
  assert.deepEqual(a.daily.map((d) => d.date), ['2026-11-01', '2026-11-05']);
  assert.deepEqual(b.daily.map((d) => d.date), a.daily.map((d) => d.date));
  assert.equal(b.delta, a.delta);
});

test('poolTrend：空输入返回 null；窗口锚在最新一条，单条老数据仍出 1 天', () => {
  assert.equal(poolTrend([]), null);
  assert.equal(poolTrend([{ ok: 5 }]), null);
  const old = [
    { at: '2019-12-30T00:00:00Z', atMs: Date.UTC(2019, 11, 30), ok: 5 },
    { at: '2020-01-02T00:00:00Z', atMs: Date.UTC(2020, 0, 2), ok: 6 },
  ];
  const t = poolTrend(old, { days: 1 });
  assert.equal(t.count, 1);
  assert.equal(t.firstDayMedian, 6);
  assert.equal(t.from, '2020-01-02T00:00:00Z');
});

test('poolTrend：total 缺失时回退到窗口内最近的有效值', () => {
  const rows = [
    { at: '2026-11-01T00:00:00Z', atMs: Date.UTC(2026, 10, 1), ok: 1, total: 158 },
    { at: '2026-11-02T00:00:00Z', atMs: Date.UTC(2026, 10, 2), ok: 2, total: null },
  ];
  assert.equal(poolTrend(rows).total, 158);
  assert.equal(poolTrend(rows.map((r) => ({ ...r, total: null }))).total, null);
});

test('renderPoolTrend：标题带时间窗与截止时间，正文声明「不是当前可用性」', () => {
  const rows = [];
  for (let d = 0; d < 3; d += 1) {
    rows.push({ at: new Date(Date.UTC(2026, 10, 1 + d, 5)).toISOString(), atMs: Date.UTC(2026, 10, 1 + d, 5), ok: 20 + d, total: 158 });
  }
  const t = poolTrend(rows, { days: 14 });
  const text = renderPoolTrend(t);
  assert.match(text, /^## 免费模型池健康（近 14 天，快照截止 2026-11-03T05:00:00\.000Z）/);
  assert.match(text, /不是当前可用性/);
  assert.match(text, /按天中位 ok/);
  assert.match(text, /11-01 20（20–20） · 11-02 21（21–21） · 11-03 22（22–22）/);
  assert.match(text, /较窗口首日：中位 ok 20 → 22（Δ\+2）/);
  assert.match(text, /total 158/);
  assert.ok(text.endsWith('\n'));
});

test('renderPoolTrend：坏行数会写明，没有就不写', () => {
  const t = poolTrend([{ at: '2026-11-01T00:00:00Z', atMs: Date.UTC(2026, 10, 1), ok: 1, total: 1 }]);
  assert.doesNotMatch(renderPoolTrend(t), /无法解析/);
  assert.match(renderPoolTrend(t, { bad: 3 }), /跳过 3 行无法解析/);
});

test('renderPoolTrend：null 趋势渲染成空串', () => {
  assert.equal(renderPoolTrend(null), '');
});

test('readPoolSnapshot：文件不存在是常态，不是错误', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-trend-'));
  try {
    const r = readPoolSnapshot(path.join(dir, 'missing.jsonl'));
    assert.deepEqual(r, { trend: null, bad: 0, problem: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readPoolSnapshot：路径是目录时报 problem，不静默当成没数据', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-trend-'));
  try {
    const r = readPoolSnapshot(dir);
    assert.equal(r.trend, null);
    assert.match(r.problem, /读不了/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readPoolSnapshot：全坏行报 problem；好行照常出趋势', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pool-trend-'));
  try {
    const badFile = path.join(dir, 'bad.jsonl');
    writeFileSync(badFile, 'nope\n{}\n');
    const bad = readPoolSnapshot(badFile);
    assert.equal(bad.trend, null);
    assert.equal(bad.bad, 2);
    assert.match(bad.problem, /全部无法解析/);

    const okFile = path.join(dir, 'ok.jsonl');
    writeFileSync(okFile, [snap(2, 20), 'nope', snap(1, 22)].join('\n'));
    const ok = readPoolSnapshot(okFile);
    assert.equal(ok.bad, 1);
    assert.equal(ok.problem, null);
    assert.equal(ok.trend.lastOk, 22);
    assert.equal(ok.trend.days, WINDOW_DAYS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('windowDays：env 可覆盖，非法值退回默认，上限 90', () => {
  const saved = process.env.DSH_POOL_SNAPSHOT_DAYS;
  try {
    delete process.env.DSH_POOL_SNAPSHOT_DAYS;
    assert.equal(windowDays(), WINDOW_DAYS);
    process.env.DSH_POOL_SNAPSHOT_DAYS = '7';
    assert.equal(windowDays(), 7);
    process.env.DSH_POOL_SNAPSHOT_DAYS = '0';
    assert.equal(windowDays(), WINDOW_DAYS);
    process.env.DSH_POOL_SNAPSHOT_DAYS = 'abc';
    assert.equal(windowDays(), WINDOW_DAYS);
    process.env.DSH_POOL_SNAPSHOT_DAYS = '1000';
    assert.equal(windowDays(), 90);
  } finally {
    if (saved === undefined) delete process.env.DSH_POOL_SNAPSHOT_DAYS;
    else process.env.DSH_POOL_SNAPSHOT_DAYS = saved;
  }
});

test('tailLines：只取最后 N 行，N 非法时退回扫描上限', () => {
  assert.deepEqual(tailLines('a\nb\nc\n', 2), ['b', 'c']);
  assert.deepEqual(tailLines('a\nb', 0), ['a', 'b']);
  assert.equal(MAX_LIMIT, 5000);
});
