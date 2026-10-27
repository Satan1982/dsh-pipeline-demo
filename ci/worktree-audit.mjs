#!/usr/bin/env node
// WT_ROOT 下的残留工作树巡检（只报不删）。
//
// 为什么只报：`git worktree remove` 会连未提交的改动一起丢，而残留目录恰恰是「上一个人
// 干到一半」的地方。删这种目录必须由人点头，机器最多说一句「这个对不上任何 open 工单了」。
// 2026-10-28 实测：`D:/code/.worktrees/reb69` 从 10-26 放到了 10-28，对应工单早关了。

// 目录名约定：`issue-<号>`（另有 `issue-<号>-ci` / `issue-<号>-rebase` 这类派生目录，
// 它们跟着主目录一起走，不单独巡检）。
export function parseWorktreeDirs(names) {
  const out = [];
  for (const raw of names ?? []) {
    const name = String(raw ?? '').trim();
    const m = /^issue-(\d+)$/.exec(name);
    if (!m) continue;
    out.push({ n: Number(m[1]), dir: name });
  }
  return out;
}

// stale = 目录在、但对应工单不在 open 里。dirty 来自 `git status --porcelain` 是否非空。
export function auditWorktrees({ dirs = [], openNumbers = [], dirty = {} }) {
  const open = new Set((openNumbers ?? []).map(Number));
  const stale = [];
  for (const d of parseWorktreeDirs(dirs)) {
    if (open.has(d.n)) continue;
    stale.push({ n: d.n, dir: d.dir, dirty: !!dirty[d.dir] });
  }
  return stale;
}

export function formatAudit(stale) {
  return (stale ?? []).map((s) => (s.dirty
    ? `[worktrees] #${s.n} 已无 open 工单，但工作树有未提交改动：${s.dir}（不自动删，人工确认）`
    : `[worktrees] #${s.n} 已无 open 工单，工作树干净：${s.dir}（可移除：git worktree remove ${s.dir}）`));
}
