#!/usr/bin/env node
// merge:auto 的仓库作用域（2026-11-07）。
//
// 原来「真实仓永不自动合并」只是文档约定：代码里只认 issue 上的 `merge:auto` 标签，
// 不看仓库是谁。于是把这条约定搬进代码：自动合并必须先过「仓库白名单」，
// 白名单只从环境变量来（`DSH_AUTO_MERGE_REPOS`，逗号分隔 owner/name），
// 不从仓库内任何文件读——agent 能在 worktree 里写文件，读仓库内配置等于让它自己发权限。
//
// 缺省值仍是试点仓：不设环境变量时行为与以前完全一致（只有 dsh-pipeline-demo 能自动合并）。
// 显式设为空串等于全禁（fail-closed，防止「误清空」被当成「不限」）。
export const ENV_KEY = 'DSH_AUTO_MERGE_REPOS';

// 缺省白名单 = 试点仓。真实仓要开自动合并，必须在启动调度器的环境里显式列出。
export const PILOT_REPO = 'Satan1982/dsh-pipeline-demo';

// 解析白名单。空串 / 只含空白 → 空数组（谁都不许）。
export function parseAllowlist(raw) {
  if (raw === undefined || raw === null) return [PILOT_REPO.toLowerCase()];
  const items = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items;
}

export function autoMergeAllowed(repo, allowlist) {
  const list = Array.isArray(allowlist) ? allowlist.map((s) => String(s).toLowerCase()) : [];
  return list.includes(String(repo ?? '').toLowerCase());
}

// 四条件 + 仓库白名单。返回 { ok, code, why }，code 给日志/事件用（便于统计哪一关拦的）。
export function decideAutoMerge({
  repo,
  allowlist,
  labels = [],
  body = '',
  ciConclusion = 'success',
  mergeState = 'clean',
} = {}) {
  if (!autoMergeAllowed(repo, allowlist)) {
    return { ok: false, code: 'repo-not-allowed', why: `仓库 ${repo || '(空)'} 不在自动合并白名单` };
  }
  if (!labels.map((l) => String(l)).includes('merge:auto')) {
    return { ok: false, code: 'no-label', why: '未打 merge:auto' };
  }
  if (String(body).includes('<!-- semantic:needs-human -->')) {
    return { ok: false, code: 'review-degraded', why: '语义评审降级/缺失，不自动合并' };
  }
  if (ciConclusion !== 'success') {
    return { ok: false, code: 'ci-not-green', why: `CI 未绿（${ciConclusion || 'unknown'}）` };
  }
  if (mergeState !== 'clean') {
    return { ok: false, code: `merge-${mergeState || 'unknown'}`, why: `不可合并（${mergeState || 'unknown'}）` };
  }
  return { ok: true, code: 'ok', why: '白名单 + merge:auto + CI 绿 + 可合并 + 评审未降级' };
}
