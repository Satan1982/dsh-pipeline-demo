#!/usr/bin/env node
// 同账号多库：一个 repos.json 里列几个 owner/name + 各自本地目录。
// 做法不是「一个进程里轮询多个库」（那要把锁/日志/worktree 全改成 per-repo 上下文，
// 236 个测试都得跟着动），而是**每库起一个自己的常驻**：子进程只多三个环境变量
// （DSH_REPO / DSH_LOG_DIR / DSH_WORKTREES），单库那条路径一行没改。
// 隔离因此是「进程级」的：锁文件在各自 .logs/dispatch.lock，工作树在各自 .worktrees，
// 日志各写各的——两个库不可能互相删标签、互相接管锁。
import path from 'node:path';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// 接受两种写法：["owner/a", "owner/b"] 或 [{repo:"owner/a", dir:"D:/code/a"}]。
// 没写 dir 就用仓库名当目录（相对清单所在目录）。
export function parseRepos(input, { baseDir = process.cwd() } = {}) {
  const raw = Array.isArray(input) ? input : Array.isArray(input?.repos) ? input.repos : null;
  if (!raw) return { entries: [], errors: ['清单必须是数组，或 {"repos": [...]}'] };
  if (!raw.length) return { entries: [], errors: ['清单是空的'] };
  const entries = [];
  const errors = [];
  const seen = new Set();
  raw.forEach((item, i) => {
    const at = `#${i + 1}`;
    const repo = typeof item === 'string' ? item : String(item?.repo ?? '');
    if (!REPO_RE.test(repo)) {
      errors.push(`${at} repo 得写成 owner/name：${repo || '(空)'}`);
      return;
    }
    const key = repo.toLowerCase();
    if (seen.has(key)) {
      errors.push(`${at} 重复：${repo}`);
      return;
    }
    seen.add(key);
    const rawDir = typeof item === 'string' ? '' : String(item?.dir ?? '').trim();
    const dir = path.resolve(baseDir, rawDir || repo.split('/')[1]);
    entries.push({ repo, dir });
  });
  return { entries, errors };
}

// 子进程只靠这三个环境变量变成「另一个库的常驻」。
// DSH_REPOS_CHILD 是保险：防止子进程又把 repos.json 读一遍，无限套娃。
export function childEnv(entry, base = process.env) {
  return {
    ...base,
    DSH_REPO: entry.repo,
    DSH_LOG_DIR: path.join(entry.dir, '.logs'),
    DSH_WORKTREES: path.join(entry.dir, '.worktrees'),
    DSH_REPOS_CHILD: '1',
  };
}

export function formatPlan(entries) {
  if (!entries.length) return ['（没有可用的库）'];
  return entries.map((e) => {
    const dir = e.dir.replace(/\\/g, '/');
    return `${e.repo}  →  ${dir}（日志 ${dir}/.logs，工作树 ${dir}/.worktrees）`;
  });
}
