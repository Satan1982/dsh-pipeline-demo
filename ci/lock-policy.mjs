#!/usr/bin/env node
// 单实例锁「算不算还活着」的判据。抽成纯函数是为了能单测：这段逻辑一错，
// 表现是「两个调度器同时跑」或「卡死的常驻永远没人接管」，两种都很难在日志里看出来。
//
// 为什么分模式（2026-10-28）：
//   serve 每轮（默认 60 秒）刷一次心跳，心跳停 3 分钟基本就是卡死或被杀；
//   而 --once 领到一张单后要在 worktree 里干到超时（默认 30 分钟）才回来，这段时间
//   心跳是停的，用 3 分钟口径会把一个正常干活的进程判死，于是两个进程抢同一棵工作树。
//   原来一律用 TIMEOUT + 10 分钟（40 分钟），代价是卡死的常驻要等 40 分钟。

export const DEFAULT_BEAT_STALE_MS = 3 * 60 * 1000;

// 老锁文件里没有 mode（滚动升级期间还在跑的旧进程）。缺省按 once 处理：
// 宁可多等 40 分钟，也不要因为认错身份把一个还在跑长任务的进程判死。
export function modeOf(raw) {
  return raw === 'serve' ? 'serve' : 'once';
}

export function staleLimitMs(mode, { beatStaleMs = DEFAULT_BEAT_STALE_MS, staleMs }) {
  return modeOf(mode) === 'serve' ? beatStaleMs : staleMs;
}

// alive 由调用方判（process.kill(pid, 0)，注意 EPERM 算活着，见 P62）。
export function lockHeld({ alive, ageMs, mode, beatStaleMs, staleMs }) {
  if (!alive) return false;
  const age = Number(ageMs);
  if (!Number.isFinite(age)) return false;
  return age < staleLimitMs(mode, { beatStaleMs, staleMs });
}

// 锁文件里的内容：pid / 心跳时间 / 模式。模式是给下一个进程判陈旧用的。
export function lockPayload({ pid, at, mode }) {
  return { pid, at, mode: modeOf(mode) };
}
