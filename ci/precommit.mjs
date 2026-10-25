#!/usr/bin/env node
/**
 * precommit.mjs — 红线规则的执行层
 *
 * 为什么需要（P0-2，来自 docs/research/products.md 与 vibe-coding-cn.md）：
 * 写在提示词里的规则 agent 可以忽略；**默认就挡住的钩子**不能。
 * 「If a rule must hold every time, make it a hook rather than a prompt instruction.」
 *
 * 这里复用评审层的规则（不另写一套，否则两边迟早不一致）：机械评审在 push 前看
 * `origin/main...HEAD`，钩子在做时看**暂存区**，两处判定口径相同。
 *
 * 保留的手工出口：`git commit --no-verify`（标准做法），以及 `DSH_ALLOW_GATE=1`
 * 放行「改门禁脚本」这一类（对应 issue 上的 allow:gate 标签）。
 */
import { spawnSync } from 'node:child_process';
import { reviewDiff, formatFindings } from './review.mjs';

const GIT = 'C:/Program Files/Git/cmd/git.exe';
const git = (args) => spawnSync(GIT, ['-c', 'credential.helper=', ...args], {
  encoding: 'utf8',
  timeout: 60_000,
});

const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRTD']);
if (staged.status !== 0) {
  console.error('✗ pre-commit 无法读取暂存区：');
  console.error(staged.stderr.trim().slice(0, 500));
  process.exit(1);
}

const names = staged.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
// 没有暂存改动时不插手（amend 出来的空提交由评审层的 no-file-change 负责）。
if (names.length === 0) process.exit(0);

const files = names.map((filename) => ({
  filename,
  patch: git(['diff', '--cached', '--unified=3', '--', filename]).stdout,
}));

const result = reviewDiff({ files, allowGate: process.env.DSH_ALLOW_GATE === '1' });
if (result.ok) {
  for (const f of result.findings) {
    console.error(`⚠ 提示 [${f.rule}] ${f.message}${f.file ? `（${f.file}）` : ''}`);
  }
  process.exit(0);
}

console.error('✗ 提交被红线规则挡下（机械评审，与 push 前评审同一套规则）：');
console.error(formatFindings(result));
console.error('');
console.error('确需提交：用 git commit --no-verify（并在 PR 里说明原因）；改门禁脚本另加 DSH_ALLOW_GATE=1。');
process.exit(1);
