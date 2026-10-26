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
import path from 'node:path';
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

// baseline-unsynced 只是「改了测试文件却没动基线」的形迹判据：改了测试文件的**断言内容**
// 但计数与指纹都没变时（比如只动 fixture 字符串），它其实不该挡提交。所以真拿门禁说一次话：
// 本地门禁过了就把这条降级成提示，没过才拦（拦得住的仍然是「真的没 bless」）。
const unsynced = result.findings.find((f) => f.rule === 'baseline-unsynced' && f.severity === 'block');
if (unsynced) {
  const bash = process.env.DSH_BASH || 'bash';
  // 门禁需要包管理器：钩子继承的是 git 的环境，PNPM_CLI 常常不在，这里按 HOME 兜一个。
  const env = { ...process.env };
  if (!env.PNPM_CLI) {
    const home = process.env.USERPROFILE || process.env.HOME || '.';
    env.PNPM_CLI = path.join(home, 'AppData', 'Local', 'Programs', 'DeepSeek Harness',
      'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs');
  }
  const gate = spawnSync(bash, ['scripts/verify.sh'], { encoding: 'utf8', timeout: 15 * 60_000, env });
  if (gate.status === 0) {
    unsynced.severity = 'warn';
    unsynced.message = '改了测试文件但计数与断言指纹都没变（本地门禁已通过），无需 bless';
  } else {
    unsynced.message = `改了测试文件但门禁没过 —— 跑 bash scripts/verify.sh --bless 后重试：\n${String(gate.stderr || gate.stdout).trim().split('\n').slice(-6).join('\n')}`;
  }
  result.ok = !result.findings.some((f) => f.severity === 'block');
}

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
