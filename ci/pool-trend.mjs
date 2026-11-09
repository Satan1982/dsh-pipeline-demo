/**
 * pool-trend.mjs — 免费模型池健康趋势（docs/dispatch.md「池子健康快照」里那条 TODO 的落地）。
 *
 * 为什么要有它：`--pool-snapshot` 往 ~/.dsh/coord/log/pool-snapshot.jsonl 追加一行，
 * 但没人每天去看。池子 2026-10-28 实测从 102 ok 掉到 34 ok（11-02 日用中位 17.5），
 * 流水线一直没有信号——只有任务开始失败才反过来暴露池子坏了。每日 distill 顺手把最近
 * 十几天的快照读成一段统计，让「池子变差」在失败之前出现在摘要里。
 *
 * 口径（三次独立审核后定的，别再改回「首尾差」）：
 * - 时间窗按天，不按行：快照会断档（实测中位间隔 1.01h，但有一个 77.5h 的空洞），
 *   48 行可能是两天，也可能是五天。
 * - 按天取中位：ok 数有强烈的日内相位（按 UTC 小时 mean 27–95），单点采样像抽签；
 *   每日尖峰（~97）是心跳刷新造成的，中位数不被它带偏。
 * - 只报统计，不下结论：不写「⚠ 池子在变差」，把每日中位与区间摆出来，让人自己判断。
 *
 * 本模块只做「解析 + 聚合 + 渲染」：不探活、不读远端、不改登记表。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** 默认时间窗：14 天。 */
export const WINDOW_DAYS = 14;

/** 扫描上限（行）：只影响「读多少行」，不决定时间窗；14 天最多 ~336 行。 */
export const MAX_LIMIT = 5000;

const DAY_MS = 86400 * 1000;
const NUM_FIELDS = ['ok', 'stale', 'suspect', 'unknown', 'down', 'other', 'total'];

/** 早于这个时间的快照不认：`new Date(null)`（1970）与认不出单位的数字都会落到这里。 */
const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);

/** 快照文件：与 `dispatch.mjs --pool-snapshot` 同一个默认路径、同一个覆盖变量。 */
export function defaultSnapshotLog() {
  return process.env.DSH_POOL_SNAPSHOT_LOG || path.join(homedir(), '.dsh', 'coord', 'log', 'pool-snapshot.jsonl');
}

/** `at` → 毫秒。接受 ISO 字符串、毫秒 epoch、秒级 epoch；其余一律 NaN（坏行）。 */
function atMsOf(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    return value >= 1e12 ? value : value >= 1e9 ? value * 1000 : NaN;
  }
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/** `ok` 必须是真数字（数字或数字字符串）；null / undefined / '' 都不算。 */
function okOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 一行一条 JSONL → { records, bad }。
 * 坏行（截断的尾部、手改坏的行、缺 ok、时间不像 2000 年以后）只计数跳过：
 * 统计不该因为一行脏数据整段消失；但坏行数要能报出去，不能静默。
 */
export function parseSnapshots(text) {
  const records = [];
  let bad = 0;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    const atMs = rec && typeof rec === 'object' ? atMsOf(rec.at) : NaN;
    const ok = rec && typeof rec === 'object' ? okOf(rec.ok) : NaN;
    if (!Number.isFinite(atMs) || atMs < MIN_PLAUSIBLE_MS || !Number.isFinite(ok)) {
      bad += 1;
      continue;
    }
    const row = { at: new Date(atMs).toISOString(), atMs, ok };
    for (const f of NUM_FIELDS) {
      if (f === 'ok') continue;
      const v = rec[f];
      const n = v === undefined || v === null || v === '' ? NaN : Number(v);
      row[f] = Number.isFinite(n) ? n : null;
    }
    records.push(row);
  }
  return { records, bad };
}

/** 只取最后 limit 行（扫描上限，不是时间窗；文件会长期增长）。 */
export function tailLines(text, limit = MAX_LIMIT) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l.trim());
  const n = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : MAX_LIMIT;
  return lines.slice(Math.max(0, lines.length - n));
}

/** 中位数（空数组给 null）。 */
function median(values) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** 时间窗天数：`DSH_POOL_SNAPSHOT_DAYS` 可覆盖；非法值退回默认，上限 90 天。 */
export function windowDays() {
  const n = Number(process.env.DSH_POOL_SNAPSHOT_DAYS);
  if (!Number.isFinite(n) || n < 1) return WINDOW_DAYS;
  return Math.min(Math.floor(n), 90);
}

/** 按 UTC 日聚合：每天 { date, count, medianOk, minOk, maxOk, last }。 */
export function dailyStats(records) {
  const rows = (records ?? [])
    .filter((r) => r && Number.isFinite(Number(r.ok)) && Number.isFinite(Number(r.atMs)))
    .slice()
    .sort((a, b) => Number(a.atMs) - Number(b.atMs));
  const byDay = new Map();
  for (const r of rows) {
    const date = r.at.slice(0, 10);
    const cur = byDay.get(date) ?? { date, oks: [], last: null };
    cur.oks.push(Number(r.ok));
    cur.last = r;
    byDay.set(date, cur);
  }
  return [...byDay.values()].map((d) => ({
    date: d.date,
    count: d.oks.length,
    medianOk: median(d.oks),
    minOk: Math.min(...d.oks),
    maxOk: Math.max(...d.oks),
    last: d.last,
  }));
}

/**
 * 窗口 → 统计。空窗口返回 null（调用方据此不出这一段）。
 * 方向/结论不在这里判断：只给每日中位序列、首日与最新一日的中位、以及总体区间。
 */
export function poolTrend(records, { days = WINDOW_DAYS } = {}) {
  const all = (records ?? [])
    .filter((r) => r && Number.isFinite(Number(r.ok)) && Number.isFinite(Number(r.atMs)))
    .slice()
    .sort((a, b) => Number(a.atMs) - Number(b.atMs));
  if (!all.length) return null;
  const span = Number.isFinite(days) && days >= 1 ? days : WINDOW_DAYS;
  const anchor = all[all.length - 1].atMs;
  const cutoff = anchor - span * DAY_MS;
  // 严格大于：正好落在 14 天前那一刻的行算窗口外，否则「近 14 天」会覆盖 15 个自然日。
  const rows = all.filter((r) => r.atMs > cutoff);
  if (!rows.length) return null;

  const daily = dailyStats(rows);
  const oks = rows.map((r) => Number(r.ok));
  const last = rows[rows.length - 1];
  const firstDayMedian = daily[0].medianOk;
  const lastDayMedian = daily[daily.length - 1].medianOk;
  // total 回退：最近一次没写 total 时用窗口里最近一个有效值，全无则 null。
  const total = last.total ?? rows.map((r) => r.total).find((v) => Number.isFinite(v)) ?? null;
  return {
    days: span,
    count: rows.length,
    from: rows[0].at,
    to: last.at,
    asOf: last.at,
    coveredDays: daily.length,
    daily,
    firstOk: oks[0],
    lastOk: Number(last.ok),
    firstDayMedian,
    lastDayMedian,
    delta: Math.round((lastDayMedian - firstDayMedian) * 10) / 10,
    minOk: Math.min(...oks),
    maxOk: Math.max(...oks),
    medianOk: median(oks),
    total,
    last,
  };
}

/** 数字 → 文本：整数不带小数点，其余保留一位。 */
function num(v) {
  if (v == null || !Number.isFinite(v)) return '未知';
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

/** 2026-11-09T11:50:24.860Z → 11-09 19:50（本地时区，给人看的）。 */
function localStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 趋势 → markdown 段（接在失败摘要后面，也可以单独成文）。 */
export function renderPoolTrend(trend, { bad = 0 } = {}) {
  if (!trend) return '';
  const total = trend.total == null ? '总数为未知' : `total ${trend.total}`;
  const sign = trend.delta > 0 ? '+' : '';
  const series = trend.daily
    .map((d) => `${d.date.slice(5)} ${num(d.medianOk)}（${d.minOk}–${d.maxOk}）`)
    .join(' · ');
  const l = trend.last;
  const parts = NUM_FIELDS.filter((f) => f !== 'total' && l[f] != null).map((f) => `${f} ${l[f]}`);
  const lines = [
    `## 免费模型池健康（近 ${trend.days} 天，快照截止 ${trend.asOf}）`,
    '',
    '> 这是历史统计，不是当前可用性；每行是一次整点快照，池子随时可能变化。',
    '',
    `- 窗口：${trend.from} → ${trend.to}（${trend.count} 次快照，覆盖 ${trend.coveredDays} 天）`,
    `- 按天中位 ok（括号内为当日区间）：${series}`,
    `- 较窗口首日：中位 ok ${num(trend.firstDayMedian)} → ${num(trend.lastDayMedian)}（Δ${sign}${num(trend.delta)}）；近期单次 ${trend.lastOk}，区间 ${trend.minOk}–${trend.maxOk} / ${total}`,
    `- 最近一次（${localStamp(trend.asOf)}）：${parts.join(' · ')}${l.total == null ? '' : ` · total ${l.total}`}`,
  ];
  if (bad > 0) lines.push(`- 跳过 ${bad} 行无法解析的快照（文件可能被截断或手改过）`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 读文件 + 取时间窗，返回 `{ trend, bad, problem }`。
 * - 文件不存在：`{ trend: null, bad: 0, problem: null }`——这是常态，不是错误。
 * - 读失败（权限/是目录/IO）：`problem` 说明原因，不再吞成「没有数据」。
 * - 窗口内全是坏行：`problem` 报出来，摘要里会写明「快照坏了」，而不是静默出空段。
 */
export function readPoolSnapshot(file = defaultSnapshotLog(), { days = windowDays() } = {}) {
  if (!existsSync(file)) return { trend: null, bad: 0, problem: null };
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = err && err.code ? err.code : '读取失败';
    return { trend: null, bad: 0, problem: `快照文件读不了（${code}）：${file}` };
  }
  const lines = tailLines(text, MAX_LIMIT);
  const { records, bad } = parseSnapshots(lines.join('\n'));
  const trend = poolTrend(records, { days });
  if (!trend && lines.length) {
    return { trend: null, bad, problem: `快照文件里最近 ${lines.length} 行全部无法解析：${file}` };
  }
  return { trend, bad, problem: null };
}

/** 兼容旧调用：只要趋势。 */
export function readPoolTrend(file, opts) {
  return readPoolSnapshot(file, opts).trend;
}
