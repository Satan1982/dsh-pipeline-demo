#!/usr/bin/env node
// ci/risk-lane.mjs —— v3 P1（docs/89 §3.4）：风险分层 lane 的机械判定 + unknown-rate 统计。
//
// 规则：
//   - lane 只有 docs / standard / high-risk 三种，靠 issue 标签声明（lane:docs 等）。
//   - 标签缺失、多个冲突、写错名字 → 一律 high-risk（fail-closed）；且计入 unknown-rate。
//   - high-risk 永远 T3：不接受 acceptance:optional 豁免、强制 verdict:strict。
//   - unknown-rate 目标 ≤5%（docs/89 §3.4）：超过只报警，不阻断（值本身要长期可测）。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const LANE = { docs: 'docs', standard: 'standard', highRisk: 'high-risk' };
export const LANE_LABELS = ['lane:docs', 'lane:standard', 'lane:high-risk'];
export const HIGH_RISK_LABEL = 'lane:high-risk';
export const UNKNOWN_RATE_TARGET = 0.05;
export const UNKNOWN_RATE_WINDOW = 100;

const nameOf = (l) => String(typeof l === 'string' ? l : (l && l.name) || '').trim().toLowerCase();

export function parseLane(labels) {
  const names = (Array.isArray(labels) ? labels : []).map(nameOf).filter(Boolean);
  const hits = names.filter((n) => LANE_LABELS.includes(n));
  if (hits.length === 0) {
    return { lane: LANE.highRisk, unknown: true, declared: null, why: '缺少 lane:* 标签（fail-closed）' };
  }
  if (hits.length > 1) {
    return { lane: LANE.highRisk, unknown: true, declared: hits.join('、'), why: `lane 标签冲突（${hits.join('、')}）` };
  }
  const lane = hits[0] === 'lane:docs' ? LANE.docs
    : hits[0] === 'lane:standard' ? LANE.standard : LANE.highRisk;
  return { lane, unknown: false, declared: hits[0], why: hits[0] };
}

// Tier 是「验证强度」的编号；high-risk 永远 3，不因上下文放宽。
export function lanePolicy(lane) {
  const l = lane === LANE.docs || lane === LANE.standard ? lane : LANE.highRisk;
  const tier = l === LANE.docs ? 1 : l === LANE.standard ? 2 : 3;
  return {
    lane: l,
    tier,
    requireAcceptance: l === LANE.highRisk,
    allowOptionalAcceptance: l !== LANE.highRisk,
    forceStrictVerdict: l === LANE.highRisk,
  };
}

export function laneStats(records) {
  const list = Array.isArray(records) ? records : [];
  const n = list.length;
  const unknown = list.filter((r) => !!r.unknown).length;
  return { n, unknown, rate: n ? unknown / n : 0, target: UNKNOWN_RATE_TARGET };
}

export function formatLaneLine(lane, stats) {
  const s = stats ?? { n: 0, unknown: 0, rate: 0 };
  const pct = (s.rate * 100).toFixed(1);
  const flag = s.rate > UNKNOWN_RATE_TARGET ? '⚠ 超过目标 5%' : `目标 ≤${(UNKNOWN_RATE_TARGET * 100).toFixed(0)}%`;
  return `lane=${lane.lane} tier=T${lanePolicy(lane.lane).tier}${lane.unknown ? `（unknown→high-risk：${lane.why}）` : ''}；unknown-rate=${pct}%（样本 ${s.n}，${flag}）`;
}

export function defaultLaneStatsFile(repoDir) {
  return path.join(repoDir, '.logs', 'lane-stats.jsonl');
}

// 落在 .logs/ 里：是遥测，不是交付物；失败不阻断任务（与 ledger 同口径）。
export function recordLane(file, record) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    return true;
  } catch {
    return false;
  }
}

// 读最后 window 条：进程重启后 unknown-rate 不归零，否则「目标 ≤5%」在每次重启面前形同虚设。
export function loadLaneStats(file, window = UNKNOWN_RATE_WINDOW) {
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-window).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- high-risk 仓外适配器（docs/89 §3.6） ----------
// 契约由仓外 tools/pipeline/run.mjs 定义，本文件只做「薄适配」：传参、解析退出码、
// 把结果回写成 evidence。不自己造 spec 格式，也不替 run.mjs 判验收。
export const RUN_EXIT = {
  0: { ok: true, reason: '全链路通过' },
  2: { ok: false, reason: '写集越界/入口产物' },
  3: { ok: false, reason: '合并冲突' },
  4: { ok: false, reason: '验收/探针/质疑者失败' },
  5: { ok: false, reason: 'worker 失败' },
  6: { ok: false, reason: '规格闸/工具漂移' },
};

// 未知退出码一律按失败处理（fail-closed）：不能让「看不懂的返回」变成放行。
export function parseRunExit(code) {
  const hit = RUN_EXIT[code];
  if (!hit) return { ok: false, code, reason: `未知退出码 ${code}（fail-closed）` };
  return { ...hit, code };
}

// 探测仓外 run.mjs：DSH_PIPELINE_RUN 显式指定，否则从 repo 的父目录找 tools/pipeline/run.mjs。
export function findRunJs(repoDir) {
  const candidates = [
    process.env.DSH_PIPELINE_RUN,
    path.join(path.dirname(path.resolve(repoDir)), 'tools', 'pipeline', 'run.mjs'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

// 起一个子进程跑 run.mjs，等它退出；stdout 的最后一个 JSON 对象作为结构化结果带回。
export async function runHighRiskAdapter({
  runJs, specDir, repoDir, verify, worker = '', max = 1, timeoutMs = 900_000, env = {},
}) {
  if (!runJs || !existsSync(runJs)) return { ok: false, code: -1, reason: `找不到 run.mjs：${runJs ?? '(null)'}`, out: '' };
  if (!specDir || !existsSync(specDir)) return { ok: false, code: -1, reason: `找不到 spec 目录：${specDir ?? '(null)'}`, out: '' };
  const args = [runJs, '--spec', specDir, '--repo', repoDir, '--verify', verify, '--max', String(max), '--json'];
  if (worker) args.push('--worker', worker);
  const r = await new Promise((done) => {
    const p = spawn(process.execPath, args, {
      cwd: repoDir, env: { ...process.env, ...env }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); done({ code: -1, out: `${out}${e.message}` }); });
    p.on('close', (code) => { clearTimeout(timer); done({ code: code ?? -1, out }); });
  });
  const parsed = parseRunExit(r.code);
  let json = null;
  try {
    const start = r.out.lastIndexOf('{');
    if (start >= 0) json = JSON.parse(r.out.slice(start));
  } catch { json = null; }
  return { ...parsed, out: r.out, json };
}
