#!/usr/bin/env node
/**
 * drift.mjs — 标签状态与本地状态的「对不对得上」判据。
 *
 * 为什么需要（2026-10-28 架构评审 P1-5）：
 * 唯一状态源是 GitHub 标签，但状态迁移是多步网络写（先打 working、再建 worktree、
 * 完成再摘 working），中间崩了/断网了就没有事务回滚。现在只有**启动时**清一次孤儿
 * `agent:working`（dispatch.mjs cleanupStaleWorking），进程跑了三天就三天没人对账。
 *
 * 这里只做判据（纯函数）+ 报警，**不自动改远端标签**：
 * 同一份标签可能属于另一台正在跑的机器，自动摘标会让那边的任务被抢。
 */
export function localDrift({ working = [], worktrees = [], active = [] } = {}) {
  const worktreeSet = new Set(worktrees.map(Number).filter(Number.isFinite));
  const activeSet = new Set(active.map(Number).filter(Number.isFinite));
  const workingSet = new Set(working.map(Number).filter(Number.isFinite));
  // 标签说「正在跑」，本地既没有 worktree 也没有正在处理 → 僵尸标签。
  const orphanLabels = [...workingSet].filter((n) => !worktreeSet.has(n) && !activeSet.has(n)).sort((a, b) => a - b);
  // 本地有 worktree，但工单既没打 working 也不在处理 → 孤儿目录（可能刚完成/被手工摘标）。
  const orphanWorktrees = [...worktreeSet].filter((n) => !workingSet.has(n) && !activeSet.has(n)).sort((a, b) => a - b);
  return {
    orphanLabels,
    orphanWorktrees,
    ok: orphanLabels.length === 0 && orphanWorktrees.length === 0,
  };
}

export function formatDrift(drift) {
  if (!drift || drift.ok) return '标签与本地状态一致';
  const parts = [];
  if (drift.orphanLabels?.length) parts.push(`agent:working 但本地无 worktree/无在跑：#${drift.orphanLabels.join(', #')}`);
  if (drift.orphanWorktrees?.length) parts.push(`本地有 worktree 但工单未在跑：#${drift.orphanWorktrees.join(', #')}`);
  return parts.join('；');
}
