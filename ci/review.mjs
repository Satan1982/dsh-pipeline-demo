/**
 * review.mjs — 开 PR 前的机械评审层
 *
 * 为什么需要: CI 只能告诉你「红了」，而且要走一个来回。评审层在 push 之前就看 diff，
 * 把能机械判定的问题挡住：删测试、漏 bless 基线、调试残留、动 workflows、加依赖。
 * 它不评价「写得好不好」——那是人工 review 的事；它只判定「这不该被推上去」。
 *
 * 判定分两档: block（拒绝通过）/ warn（允许通过，但记下来）。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 只在「新增的行」里找：删除行本来就该被删。
const DEBUG_RESIDUE = [
  { re: /\bBROKEN\b/, why: '调试占位符（BROKEN）' },
  { re: /\bdebugger\b/, why: 'debugger 语句' },
  { re: /^(?:<<<<<<<|=======|>>>>>>>)\s/, why: '未解决的冲突标记' },
  { re: /\bconsole\.log\(\s*["'`]DEBUG/, why: '调试日志' },
  { re: /\.only\(/, why: 'it.only/test.only 会让其余用例静默跳过' },
  { re: /\bTODO\(agent\)/, why: '留给自己的 TODO 没做' },
];

const BLOCK_PREFIX = [
  { prefix: '.github/workflows/', why: '禁止改 CI 定义（需要人工改动时单独开 PR）' },
];

function addedLines(patch) {
  return String(patch ?? '')
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

function removedLines(patch) {
  return String(patch ?? '')
    .split('\n')
    .filter((l) => l.startsWith('-') && !l.startsWith('---'))
    .map((l) => l.slice(1));
}

const isTestFile = (f) => /^(?:src|ci)\/.*\.test\.(?:js|mjs)$/.test(f);
const BASELINES = ['scripts/test-baseline.txt', 'scripts/assert-baseline.txt'];

/**
 * @param {{files: Array<{filename: string, status?: string, patch?: string}>}} diff
 */
const GATE_FILES = ['scripts/verify.sh', 'scripts/assert-guard.mjs', 'ci/dispatch.mjs', 'ci/review.mjs'];

export function reviewDiff(diff) {
  const files = diff?.files ?? [];
  const allowGate = Boolean(diff?.allowGate);
  const findings = [];
  const add = (severity, rule, message, file) => findings.push({ severity, rule, message, file });

  const changed = new Set(files.map((f) => f.filename));
  let totalAdded = 0;

  for (const f of files) {
    const added = addedLines(f.patch);
    totalAdded += added.length;

    for (const { prefix, why } of BLOCK_PREFIX) {
      if (f.filename.startsWith(prefix)) add('block', 'forbidden-path', why, f.filename);
    }

    for (const line of added) {
      for (const { re, why } of DEBUG_RESIDUE) {
        if (re.test(line.trim())) {
          add('block', 'debug-residue', `${why}：${line.trim().slice(0, 120)}`, f.filename);
        }
      }
    }

    // 删测试/删断言：即使数量基线能挡住，也要在 push 前直接说清楚
    if (isTestFile(f.filename)) {
      for (const line of removedLines(f.patch)) {
        const t = line.trim();
        if (/^test\(/.test(t) || /^it\(/.test(t)) {
          add('block', 'test-removed', `删掉了一个用例：${t.slice(0, 120)}`, f.filename);
        } else if (/^assert\./.test(t)) {
          add('block', 'assert-removed', `删掉了一条断言：${t.slice(0, 120)}`, f.filename);
        }
      }
    }

    // 加依赖必须人工批
    if (f.filename === 'package.json') {
      if (added.some((l) => /"(?:dev)?[dD]ependencies"/.test(l))) {
        add('block', 'dependency-added', 'package.json 新增了依赖声明，需要人工批准', f.filename);
      }
    }

    // 门禁脚本本身是保护对象：默认阻断。确需改门禁的工单打 allow:gate label 放行。
    if (GATE_FILES.includes(f.filename)) {
      add(allowGate ? 'warn' : 'block', 'gate-modified',
        allowGate
          ? '修改了门禁脚本（已按 allow:gate 放行，合并前仍请人工确认没有放宽标准）'
          : '修改了门禁脚本本身；确需修改请在 issue 上打 allow:gate label 后重跑', f.filename);
    }
  }

  // 改了测试文件却没动基线 = 忘了 --bless（PR #22 就是这样混过去的）
  const touchedTests = files.some((f) => isTestFile(f.filename));
  if (touchedTests && !BASELINES.some((b) => changed.has(b))) {
    add('block', 'baseline-unsynced',
      '改了测试文件但没更新 scripts/test-baseline.txt / assert-baseline.txt —— 跑 bash scripts/verify.sh --bless',
      null);
  }

  // 空 diff 不算「干活」：agent 为了满足「必须有改动」可以造一个空提交（PR #40 就是这样），
  // 到了评审层必须当阻断——没有文件变化的 PR 没有可评审的内容，也不该让 CI 白跑一遍。
  if (files.length === 0) {
    add('block', 'no-file-change',
      '这次提交没有任何文件变化（可能是为了绕过「必须有改动」而造的空提交）；只读任务请打 readonly:ok',
      null);
  }

  if (totalAdded > 400) {
    add('warn', 'diff-large', `单次改动 ${totalAdded} 行，建议拆成更小的垂直切片`, null);
  }

  return {
    ok: !findings.some((f) => f.severity === 'block'),
    findings,
    totalAdded,
  };
}

export function formatFindings(result) {
  if (result.findings.length === 0) return '评审通过：没有发现问题。';
  return result.findings
    .map((f) => `${f.severity === 'block' ? '✗ 阻断' : '⚠ 提示'} [${f.rule}] ${f.message}${f.file ? `（${f.file}）` : ''}`)
    .join('\n');
}

/**
 * 在 worktree 里真正跑一次评审：取 base...HEAD 的 diff 再判定。
 */
export function reviewWorktree(cwd, base = 'origin/main', options = {}) {
  const git = (args) => spawnSync('C:/Program Files/Git/cmd/git.exe', args, {
    cwd, encoding: 'utf8', timeout: 60_000,
  });

  const names = git(['diff', '--name-only', `${base}...HEAD`]);
  if (names.status !== 0) {
    return { ok: false, findings: [{ severity: 'block', rule: 'diff-failed', message: names.stderr.trim().slice(0, 300), file: null }], totalAdded: 0 };
  }
  const list = names.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const files = list.map((filename) => {
    const p = git(['diff', `${base}...HEAD`, '--', filename]);
    return { filename, patch: p.stdout };
  });
  return reviewDiff({ files, allowGate: Boolean(options.allowGate) });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cwd = process.cwd();
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const base = positional[0] ?? 'origin/main';
  const r = reviewWorktree(cwd, base, { allowGate: process.argv.includes('--allow-gate') });
  console.log(formatFindings(r));
  console.log(`\n${r.ok ? 'REVIEW: OK' : 'REVIEW: BLOCKED'}（新增 ${r.totalAdded} 行）`);
  process.exit(r.ok ? 0 : 1);
}
