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
export const INCLUDE_PAID_ENV = 'DSH_PROBE_INCLUDE_PAID';

// probe.py 里 `kind === "video"` 直接 return「跳过（视频生成耗时长，未纳入自动巡检）」，
// 没有任何 flag 能让它被测 —— 挂在候选里只会把「选中 N 个」变成又一次空跑。
// 所以挑之前也按 kind 过滤，并把跳过的数量单独报出来。
export const UNPROBEABLE_KINDS = ['video'];

// 挑谁、跳过谁：登记表里 free === false 的模型（千帆按量、glm/kimi 付费档）probe.py
// 不带 --include-paid 会整组 continue。而按 id 字典序排在最前的恰好全是这批，
// 于是「每天选中同一批、每天被试跑跳过」= 空转，日志却写「探活 N 个」。
// 所以挑之前先按免费面过滤，并把跳过的数量单独报出来给人看。
export function planProbe(stats, { limit = DEFAULT_LIMIT, paid = null, kindOf = null } = {}) {
  const all = listModels(stats);
  const rank = (s) => (s === 'stale' ? 0 : 1);
  const isPaid = typeof paid === 'function' ? paid : () => false;
  const kind = typeof kindOf === 'function' ? kindOf : () => null;
  const skipKind = (m) => UNPROBEABLE_KINDS.includes(kind(m.id));
  const stale = all.filter((m) => PROBE_STATUSES.includes(m.status));
  const skipped = stale.filter((m) => isPaid(m.id)).map((m) => m.id).sort();
  const skippedKind = stale.filter((m) => !isPaid(m.id) && skipKind(m)).map((m) => m.id).sort();
  const candidates = stale.filter((m) => !isPaid(m.id) && !skipKind(m));
  const picked = candidates
    .sort((a, b) => (rank(a.status) - rank(b.status)) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map((m) => m.id);
  return {
    total: all.length,
    stale: stale.length,
    candidates: candidates.length,
    skippedPaid: skipped.length,
    skippedPaidIds: skipped,
    skippedKind: skippedKind.length,
    skippedKindIds: skippedKind,
    picked: [...new Set(picked)],
  };
}

export function staleTargets(stats, { limit = DEFAULT_LIMIT, paid = null, kindOf = null } = {}) {
  return planProbe(stats, { limit, paid, kindOf }).picked;
}

// probe.py 的 --only 是「id 含这些子串」的过滤，逗号分隔。
// 「没挑中任何模型」时返回空数组——别拼出 `--only ""`，那等于让 probe 测全部。
export function probeArgv(ids, { quiet = true, includePaid = false } = {}) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return [];
  const argv = ['--only', list.join(',')];
  if (includePaid) argv.push('--include-paid');
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
