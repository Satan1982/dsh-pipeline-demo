#!/usr/bin/env node
// 免费池里躺着不少 stale 模型：它们不是坏了，只是「上次失败、还没再试过」。
// 池子健康快照直接决定强档 patch 选谁，所以偶尔主动探一遍能把可用面拉回来。
//
// 这里只做「探谁、怎么探、怎么读结果」三个纯判断；真正跑 python 留在 dispatch.mjs，
// 方便单测，也避免测试真的去连网。
export const DEFAULT_LIMIT = 8;
export const PROBE_STATUSES = ['stale', 'unknown'];

// 池子健康快照的形状有两种（fm.py stats --json 的外层包了一层 models），统一成 [{id, status}]。
export function listModels(stats) {
  const src = stats && typeof stats === 'object' && stats.models ? stats.models : stats;
  if (Array.isArray(src)) {
    return src.map((m) => ({ id: String(m?.id ?? m?.model ?? ''), status: String(m?.status ?? 'unknown') })).filter((m) => m.id);
  }
  if (src && typeof src === 'object') {
    return Object.entries(src).map(([id, v]) => ({ id, status: String(v?.status ?? v ?? 'unknown') }));
  }
  return [];
}

// 优先级：stale 先（失败过但可能已恢复），unknown 后（从没测过，更不确定）。
// 同状态按 id 排序，保证同一份快照每次挑出来的是同一批，便于对照。
export function staleTargets(stats, { limit = DEFAULT_LIMIT } = {}) {
  const all = listModels(stats);
  const rank = (s) => (s === 'stale' ? 0 : 1);
  const picked = all
    .filter((m) => PROBE_STATUSES.includes(m.status))
    .sort((a, b) => (rank(a.status) - rank(b.status)) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((m) => m.id);
  return [...new Set(picked)];
}

// probe.py 的 --only 是「id 含这些子串」的过滤，逗号分隔。
// 「没挑中任何模型」时返回空数组——别拼出 `--only ""`，那等于让 probe 测全部。
export function probeArgv(ids, { quiet = true } = {}) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return [];
  const argv = ['--only', list.join(',')];
  if (quiet) argv.push('--quiet');
  return argv;
}

// probe 的 stdout 很长（每个模型一段）。只留含「ok / fail / 统计」的最后几行给人看。
export function summarizeProbe(stdout, { maxLines = 3 } = {}) {
  const lines = String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /ok|fail|stale|个模型|总计|合计/i.test(l));
  return lines.slice(-maxLines);
}
