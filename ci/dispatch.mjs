#!/usr/bin/env node
/**
 * dispatch.mjs — GitHub Issues → DSH headless agent → PR
 *
 * 轮询带 `agent:ready` label 的 issue，在隔离 worktree 里让 headless agent 干活，
 * 通过后自动推分支并开 PR。人只负责写 issue 和 review/merge。
 *
 * 用法:
 *   node ci/dispatch.mjs --ensure   确保后台有常驻调度器（没有就脱离父进程拉起一个）
 *   node ci/dispatch.mjs --serve    常驻轮询（--ensure 拉起时用它；不带参数默认也是它）
 *   node ci/dispatch.mjs --once     跑一轮就退出（适合本地验证与计划任务）
 *   node ci/dispatch.mjs --dry-run  只列出待办 issue，不执行
 *
 * 环境变量:
 *   DSH_REPO               owner/repo，默认 Satan1982/dsh-pipeline-demo
 *   DSH_POLL_INTERVAL      轮询秒数，默认 60
 *   DSH_TASK_TIMEOUT_MS    单任务超时，默认 30 分钟
 */
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { fingerprint, recordFailure, formatPriorFailures } from './failures.mjs';
import { headlessKind } from './headless-kind.mjs';
import { sumUsage, formatUsage, finalText, sessionIdOf } from './usage.mjs';
import { reviewWorktree, formatFindings } from './review.mjs';
import { collectDiff, reviewWithPanel, formatSemantic } from './semantic-review.mjs';
import { classifyConflicts } from './rebase-conflict.mjs';
import { decideAcceptance } from './verdict.mjs';

// Windows 上 Node 自带 CA 不含系统根证书，必须 --use-system-ca，否则 api.github.com 报
// "unable to verify the first certificate"。没有该 flag 时自重启补上。
if (!process.execArgv.includes('--use-system-ca')) {
  const r = spawnSync(process.execPath, ['--use-system-ca', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const REPO      = process.env.DSH_REPO ?? 'Satan1982/dsh-pipeline-demo';
const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const io_url = fileURLToPath(import.meta.url);
const REPO_DIR_RAW = path.dirname(path.dirname(io_url));
const SECRETS_DIR = process.env.DSH_SECRETS_DIR || path.join(path.dirname(REPO_DIR_RAW), '.secrets');
const TOKEN_FILE = process.env.DSH_GITHUB_TOKEN_FILE || path.join(SECRETS_DIR, 'github-token.txt');
// 惰性读取：模块顶层读文件会让 CI 里的「能否 import」测试直接失败（那里没有 token 文件）。
let TOKEN_CACHE = '';
function token() {
  if (!TOKEN_CACHE) TOKEN_CACHE = readFileSync(TOKEN_FILE, 'utf8').trim();
  return TOKEN_CACHE;
}
const GIT = process.env.DSH_GIT || 'C:/Program Files/Git/cmd/git.exe';
const BASH = process.env.DSH_BASH || path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', '@dsh-ops', 'bash-win32-x64', 'bin', 'bash.exe');
const ASKPASS = process.env.DSH_ASKPASS || path.join(SECRETS_DIR, 'askpass.sh');
const REPO_DIR = REPO_DIR_RAW;
const WT_ROOT = process.env.DSH_WORKTREES || path.join(path.dirname(REPO_DIR), '.worktrees');
const STRONG_PATCH = process.env.DSH_HEADLESS_STRONG_PATCH || path.join(SECRETS_DIR, 'headless-model-strong.yml');
const REBASE_AGENT_TIMEOUT_MS = Number(process.env.DSH_REBASE_TIMEOUT_MS ?? 8 * 60 * 1000);
const TIMEOUT = Number(process.env.DSH_TASK_TIMEOUT_MS ?? 30 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.DSH_MAX_ATTEMPTS ?? 3);
// 限流不是逻辑失败：单独计数、单独上限，不占 MAX_ATTEMPTS 的预算。
const RATE_LIMIT_MAX = Number(process.env.DSH_RATE_LIMIT_MAX ?? 4);
const RATE_LIMIT_RETRIES = new Map();
// dsh 每个 headless 运行都会在 <home>/.dsh/sessions/<cwd 转义>/session-<uuid>/ 下留一份会话。
// worktree 用完就删了，这些会话会一直堆着（2026-10-26 实测 2 天堆了 95 个）。开机时把「工作区已不存在」
// 的那些整体移进 sessions-archived/pipeline-old（只搬不删），并清掉空的转义壳。
const SESSIONS_DIR = path.join(HOME, '.dsh', 'sessions');
const SESSIONS_ARCHIVE = path.join(HOME, '.dsh', 'sessions-archived', 'pipeline-old');

function escapeCwd(p) {
  return '--' + p.replace(/:/g, '').replace(/[\/]/g, '-') + '--';
}

async function pruneDeadSessions() {
  const listed = (await git(['worktree', 'list', '--porcelain'])).out;
  const live = new Set(
    listed.split(NL).filter((l) => l.startsWith('worktree ')).map((l) => escapeCwd(l.slice('worktree '.length).trim())),
  );
  if (!existsSync(SESSIONS_DIR)) return 0;
  let moved = 0;
  for (const shard of readdirSync(SESSIONS_DIR)) {
    const dir = path.join(SESSIONS_DIR, shard);
    if (!shard.includes('.worktrees') || live.has(shard)) continue;
    for (const session of readdirSync(dir)) {
      if (!session.startsWith('session-')) continue;
      const dst = path.join(SESSIONS_ARCHIVE, shard, session);
      try {
        mkdirSync(path.dirname(dst), { recursive: true });
        renameSync(path.join(dir, session), dst);
        moved += 1;
      } catch { /* 单个搬不动不影响其它 */ }
    }
    try { if (!readdirSync(dir).length) rmdirSync(dir); } catch { /* 非空就算了 */ }
  }
  return moved;
}

// 每个工单最近一次 headless 跑在哪个会话里；只有限流/进程没起来这类环境噪声才复用它。
const ISSUE_SESSION = new Map();
// 同一提交最多试几次自动 rebase。基线冲突现在能自动重算、源码冲突交给 agent，
// 所以失败几次多半是工具/网络问题，给到 5 次；同一个 sha 上的失败评论用来计数。
const REBASE_MAX_TRIES = Number(process.env.DSH_REBASE_MAX_TRIES ?? 5);
// 仅用于验证重试状态机：前 N 次尝试强制失败，不真正调模型
const DEBUG_FAIL = Number(process.env.DSH_DEBUG_FAIL_ATTEMPTS ?? 0);
const CONCURRENCY = Math.max(1, Number(process.env.DSH_CONCURRENCY ?? 2));
const ONCE      = process.argv.includes('--once');
const ENSURE    = process.argv.includes('--ensure');
const SELF      = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DRY       = process.argv.includes('--dry-run');
const INTERVAL  = Number(process.env.DSH_POLL_INTERVAL ?? 60) * 1000;

function gitEnv() {
  return { GIT_ASKPASS: ASKPASS, GIT_TOKEN: token(), GIT_TERMINAL_PROMPT: '0' };
}
// https 通道会间歇性不通（实测同一天里 10 次全通、8 次全失败两个极端）。仓库上挂了一把
// write 部署密钥，于是留一条走 ssh.github.com:443 的备用通道：两种协议独立，谁通走谁。
// GIT_SSH_COMMAND 会被 git 原样交给 shell，Windows 反斜杠会被吃掉（实测 `D:\\code\\.secrets\\ssh-git.sh`
// 变成 `D:code.secretsssh-git.sh: command not found`），所以这里统一转成正斜杠。
const posix = (p) => p.replace(/\\/g, '/');
const SSH_WRAPPER = posix(process.env.DSH_SSH_WRAPPER || path.join(SECRETS_DIR, 'ssh-git.sh'));
const SSH_REMOTE = `ssh://git@ssh.github.com:443/${REPO}.git`;
// 惰性构造：模块顶层一旦读 token 文件，CI（没有 .secrets）里 import 就会 ENOENT。
function sshEnv() { return { ...gitEnv(), GIT_SSH_COMMAND: SSH_WRAPPER, GIT_SSH_VARIANT: 'ssh' }; }

function networkError(r) {
  const t = `${r?.err ?? ''}${r?.out ?? ''}`;
  return /Failed to connect|Connection was reset|Recv failure|Could not resolve host|Connection timed out|early EOF/i.test(t);
}

// 随包运行时根目录：.../dependencies/node/bin/node.exe 上溯三级才是 dependencies。
// 上溯两级会落到 .../dependencies/node，PNPM_CLI 随之指向不存在的 node/pnpm/bin。
const INSTALL_DIR = process.env.DSH_INSTALL || path.join(HOME, 'AppData', 'Local', 'Programs', 'DeepSeek Harness');
const BUNDLE_DIR = process.env.DSH_BUNDLE_DIR || path.join(HOME, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies');
const PNPM_CLI = process.env.PNPM_CLI || path.join(BUNDLE_DIR, 'pnpm', 'bin', 'pnpm.cjs');
const FAIL_STORE = path.join(REPO_DIR, 'docs', 'failures.jsonl');

// 计划任务里的 PATH 不含 node/git；显式把当前 node 与 git 所在目录拼进去，
// 否则被调起的 headless agent 在 verify.sh 里跑 `node` 会 command not found。
const CHILD_PATH = [
  path.dirname(process.execPath),
  path.dirname(GIT),
  process.env.PATH,
].filter(Boolean).join(path.delimiter);

// 计划任务里 stdout 无处可去，必须自己落盘，否则无人值守跑完什么都看不到。
const LOG_DIR = process.env.DSH_LOG_DIR || path.join(REPO_DIR, '.logs');
// 换行常量：本文件里避免在模板字符串中写转义（历史上被脚本改坏过两次）。
const NL = String.fromCharCode(10);
const LOG_FILE = path.join(LOG_DIR, 'dispatch.log');
const log = (m) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  console.log(line);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch { /* 日志失败不能影响主流程 */ }
};

// 每次尝试都会落一份 prompt 和一份完整输出；无人值守跑几天就是几千个文件。
// 只清理「目录里看起来像尝试产物」的文件，别的（锁、轮转后的 .1）一律不碰。
const LOG_RETENTION_DAYS = Number(process.env.DSH_LOG_RETENTION_DAYS || 7);
function pruneLogs() {
  let removed = 0;
  try {
    if (!existsSync(LOG_DIR)) return 0;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 3600 * 1000;
    for (const name of readdirSync(LOG_DIR)) {
      if (!/^issue-\d+-attempt-\d+\.(log|prompt\.md)$/.test(name)) continue;
      const p = path.join(LOG_DIR, name);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed += 1; }
      } catch { /* 单个文件删不掉不影响其它 */ }
    }
  } catch { /* 目录读不了就算了 */ }
  return removed;
}

// ---------- 基础设施 ----------

async function api(method, p, body) {
  const r = await fetch(`https://api.github.com${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-dispatch',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok && r.status !== 404) {
    throw new Error(`${method} ${p} -> ${r.status} ${String(text).slice(0, 300)}`);
  }
  return { status: r.status, data };
}

function run(cmd, args, { cwd, env, timeout, input, clean } = {}) {
  return new Promise((resolve) => {
    // clean=true 时完全不用父进程的 env：给 agent 的子进程必须走这条，
    // 否则调度器环境里的凭据（GIT_TOKEN / 各种 API key）会随环境泄漏给模型。
    const p = spawn(cmd, args, { cwd, env: clean ? { ...env } : { ...process.env, ...env } });
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    const timer = timeout ? setTimeout(() => p.kill('SIGKILL'), timeout) : null;
    p.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, out, err: err + e.message }); });
    p.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
  });
}

// 本机全局配置把 https://github.com/ 重写成 ghfast.top 镜像（fetch 加速），
// 而全局 credential.helper=manager 给 ghfast.top 的凭据是错的，实测 fetch 100% 报
// `remote: Repository not found.`。统一禁用 GCM、只让 GIT_ASKPASS 供凭据后 3/3 成功。
const git = (args, opts = {}) =>
  run(GIT, ['-c', 'credential.helper=', ...args], {
    ...opts,
    cwd: opts.cwd ?? REPO_DIR,
    env: { ...gitEnv(), ...(opts.env ?? {}) },
  });

// github.com:443 整晚会间歇性连不上（2026-10-25 实测：同一分钟 api.github.com 200、
// github.com 超时或 Connection was reset）。fetch 挂在这里是链路抖，不是仓库或凭据的问题，
// 所以任何「一定要拿到最新 main」的 fetch 都走这个退避（约 95 秒窗口）。
const FETCH_BACKOFF_MS = [5000, 10000, 20000, 30000, 30000];

async function fetchWithRetry(args = ['origin', '--quiet'], cwd = REPO_DIR) {
  let last = null;
  for (let i = 0; i <= FETCH_BACKOFF_MS.length; i += 1) {
    last = await git(['fetch', ...args], { cwd });
    if (last.code === 0) return last;
    if (i < FETCH_BACKOFF_MS.length) await new Promise((r) => setTimeout(r, FETCH_BACKOFF_MS[i]));
  }
  if (networkError(last)) {
    // 换协议再试：SSH 端点与 https 走不同的主机与端口，抖动很少同时命中两边。
    log('[net] https 取不到，改走 SSH 端点');
    const viaSsh = await run(GIT, ['-c', 'credential.helper=', 'fetch', SSH_REMOTE,
      '+refs/heads/*:refs/remotes/origin/*'], { cwd, env: sshEnv() });
    if (viaSsh.code === 0) return viaSsh;
    last = viaSsh;
  }
  throw new Error(`git fetch 失败（退避重试 ${FETCH_BACKOFF_MS.length + 1} 次 + SSH 端点）: ${last.err.trim().slice(0, 200)}`);
}

// ---------- 单实例锁 ----------
// 计划任务每 5 分钟一轮，人（或 agent）也可能手动跑一次；两个进程会抢同一个
// worktree 路径和分支，表现为「agent 未产生任何改动」这种假故障。用文件锁串行化。
const LOCK_FILE = path.join(LOG_DIR, 'dispatch.lock');
const LOCK_STALE_MS = TIMEOUT + 10 * 60 * 1000;

// 谁在跑：只有「进程还活着且锁不算太旧」才算占用，否则视为陈旧可接管。
function lockHolder() {
  let cur = null;
  try { cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
  if (!cur?.pid) return null;
  let alive = false;
  try { process.kill(cur.pid, 0); alive = true; } catch { alive = false; }
  const age = cur.at ? Date.now() - Date.parse(cur.at) : Infinity;
  return alive && age < LOCK_STALE_MS ? cur : null;
}

function ownsLock() {
  try { return JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid === process.pid; } catch { return false; }
}

function acquireLock() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const me = { pid: process.pid, at: new Date().toISOString() };
  const write = () => writeFileSync(LOCK_FILE, JSON.stringify(me));
  // 只有锁还是自己写的那份才删。常驻进程被接管后退出时若无条件 unlink，会把新持有者的锁删掉，
  // 第三个进程再「接管」一次——2026-10-25 07:17 实测就是这样滚成「谁都没有锁、也没有常驻进程」。
  const release = () => {
    try {
      if (JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid !== process.pid) return;
      unlinkSync(LOCK_FILE);
    } catch { /* 已经没了 */ }
  };

  try {
    writeFileSync(LOCK_FILE, JSON.stringify(me), { flag: 'wx' });
    return { ok: true, release };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  if (lockHolder()) return { ok: false, holder: lockHolder() };

  let cur = null;
  try { cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch { cur = null; }
  log(`接管陈旧锁（pid=${cur?.pid ?? '?'} 起于 ${cur?.at ?? '?'}）`);
  write();
  // 两个进程可能同时判「陈旧」并各写一份锁；写完必须回头确认赢的是自己，否则让位。
  if (!ownsLock()) {
    let other = null;
    try { other = JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch { /* 读不到就让上面那次重试 */ }
    return { ok: false, holder: other ?? { pid: '?', at: '?' } };
  }
  return { ok: true, release };
}

// ---------- 并发原语 ----------

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// .git/worktrees 与 refs 不是并发安全的，worktree 的建删必须串行
let wtLock = Promise.resolve();
function locked(fn) {
  const p = wtLock.then(fn, fn);
  wtLock = p.then(() => {}, () => {});
  return p;
}

async function setupWorktree(branch, wt, baseRef) {
  return locked(async () => {
    await fetchWithRetry();
    await git(['worktree', 'remove', '--force', wt]);
    await git(['branch', '-D', branch]);
    const add = await git(['worktree', 'add', wt, '-b', branch, baseRef]);
    if (add.code !== 0) throw new Error(`worktree add 失败: ${add.err.trim()}`);
    // 红线执行层（P0-2）：打开仓库里的钩子目录。规则在 ci/precommit.mjs，
    // agent 想「不读 AGENTS.md 硬推」时会被钩子直接挡在 commit 之前。
    const hooks = await git(['config', 'core.hooksPath', '.githooks']);
    if (hooks.code !== 0) log(`⚠ 没能启用 pre-commit 钩子：${hooks.err.trim().slice(0, 200)}`);
  });
}

// ---------- Issue 解析 ----------

function parseSections(body) {
  const out = {};
  for (const part of String(body ?? '').split(/^### /m).slice(1)) {
    const nl = part.indexOf('\n');
    if (nl < 0) continue;
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}

function pick(sections, ...keys) {
  for (const [k, v] of Object.entries(sections)) {
    if (keys.some((key) => k.includes(key))) return v;
  }
  return '';
}

// issue 里的验收命令几乎总是包在 ``` 代码块里。直接把围栏当命令跑，bash 会把
// “VERDICT:” 当成命令名（实测 `/usr/bin/bash: line 10: VERDICT:: command not found`），
// 于是明明验收通过却被判成「没打印 VERDICT 行」。这里只剥最外层的一对围栏。
function stripFence(text) {
  return String(text ?? '')
    .replace(/^\s*```[a-zA-Z0-9_-]*[ \t]*\r?\n/, '')
    .replace(/\r?\n?\s*```\s*$/, '')
    .trim();
}

// 规则与计划物化（P0-3）：把 issue 的三段验收变成工作区里的一页 PLAN.md。
// agent 读文件比读 5 KB 提示词更可靠，人工也能在 worktree 里直接对照。
function writePlan(wt, { n, title, goal, acceptance, constraints, cmds }) {
  const body = [
    `# issue #${n}：${title}`,
    '',
    '这份文件由调度器按 issue 生成，是本次任务的唯一验收清单。',
    '',
    '## 目标',
    goal.trim() || '（issue 没写目标）',
    '',
    '## 验收标准',
    acceptance.trim() || '（issue 没写验收标准）',
    '',
    '## 验收命令（调度器会自己跑一遍，必须 exit 0）',
    cmds.trim()
      ? ['```', cmds.trim(), '```'].join(NL)
      : '（没有提供验收命令——本工单不允许进交付流程）',
    '',
    '## 约束',
    constraints.trim() || '（issue 没写约束）',
    '',
    '## 硬性红线（pre-commit 钩子会挡）',
    '- 不许删/改已有测试与断言来凑绿；基线必须 `bash scripts/verify.sh --bless` 同步。',
    '- 不许改 `.github/workflows/`、`scripts/verify.sh`、`scripts/assert-guard.mjs`、`ci/*`（需要时在 issue 打 `allow:gate`）。',
    '- 不许留调试占位符、断点语句、只跑单个用例的标记或调试日志（评审层会逐条列出具体行）。',
    '- 不许加依赖；一 PR 一个垂直切片。',
  ].join(NL);
  try {
    const dir = path.join(wt, '.dsh');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'PLAN.md'), `${body}${NL}`);
    // 光靠 .git/info/exclude 不够稳：#62 的 agent 一进来就看到 .dsh/PLAN.md 是「未跟踪改动」，
    // 还在总结里专门解释了一遍。目录内再放一个 .gitignore，让任何 git 状态都看不见它。
    writeFileSync(path.join(dir, '.gitignore'), `*${NL}`);
    // 不污染 PR：把它们排除在工作区之外（worktree 共享同一份 .git/info/exclude）。
    const exclude = run(GIT, ['rev-parse', '--git-path', 'info/exclude'], { cwd: wt });
    if (exclude.code === 0) {
      const file = path.resolve(wt, exclude.out.trim());
      const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (!cur.includes('.dsh/')) appendFileSync(file, `${cur.endsWith(NL) || !cur ? '' : NL}.dsh/${NL}`);
    }
  } catch (e) {
    log(`⚠ 写 PLAN.md 失败（不影响任务）：${e.message}`);
  }
}

function buildPrompt({ n, title, goal, acceptance, constraints, attempt = 1, priorFailure = '', readonly = false }) {
  const readonlyBlock = readonly
    ? `\n## 只读任务（最高优先级）\n这是只读工单：只做调查/验证并给出结论，**绝对不要创建、修改或删除任何文件**，包括临时脚本和 wrapper。\n- 只读检查用 \`node -e\` 或 \`grep\` 完成，不落盘；\n- 结论写进最终回答（文件路径 + 行号 + 事实），调度器会把它贴到 issue 上；\n- 不要为了「产生改动」而提交或写文件。\n`
    : '';
  const retryBlock = priorFailure
    ? `\n## 上次失败原因（这是第 ${attempt} 次尝试，必须针对性修复，不要重复同样的错误）\n${String(priorFailure).slice(0, 3000)}\n`
    : '';
  // 失败指纹库命中时，把「同一个根因以前出现过」连同上次修法一起喂进去，
  // 避免换个工单又从零摸索。
  const known = priorFailure ? formatPriorFailures(priorFailure, FAIL_STORE) : '';
  const knownBlock = known
    ? `\n## 历史同类失败（调度器记忆库）\n${known}\n\n先确认这次的根因是否与上次一致；一致就直接照上次的修法，不要重新试错。\n`
    : '';
  return `你正在一个隔离的 git worktree 里工作。任务来自 GitHub Issue #${n}：${title}
${retryBlock}${knownBlock}${readonlyBlock}
## 目标
${goal}

## 验收标准（必须全部满足）
${acceptance}

## 约束
${constraints || '（无额外约束）'}

## 硬性规则
1. 先读仓库根目录的 AGENTS.md，遵守其中的约定。
2. 完成后必须运行 \`bash scripts/verify.sh\` 并确保通过（lint + 测试 + 构建 + 打包）。
3. **不要执行 git commit / git push / gh 命令** —— 调度器会负责提交、推送和开 PR。
4. 不要修改 .github/workflows/*，不要新增依赖，不要为了过测试而修改或删除已有测试断言。
5. 只有验收标准全部满足才算完成；做不到就停下来说明卡在哪，不要假装完成。

现在开始。`;
}

// ---------- 单个任务 ----------

async function failTask(issue, reason) {
  const n = issue.number;
  const r = String(reason).slice(0, 2000);
  log(`[issue #${n}] FAILED: ${r.split('\n')[0].slice(0, 200)}`);
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
  // 必须摘掉 agent:ready，否则下一轮轮询会把失败的 issue 再次领取
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:ready')}`).catch(() => {});
  await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:failed'] }).catch(() => {});
  await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
    body: `❌ 调度器执行失败：\n\n\`\`\`\n${r}\n\`\`\`\n\n处理完后去掉 \`agent:failed\`、重新加 \`agent:ready\` 即可重试。`,
  }).catch(() => {});
}

// ---------- 独立门禁 + 评审层 ----------
// agent 会声称自己跑过了 verify.sh。这里不信自述，调度器自己在同一个 worktree
// 里再跑一遍；红就是红，绿才有资格进下一步。

async function verifyWorktree(wt) {
  const v = await run(BASH, ['scripts/verify.sh'], {
    cwd: wt, timeout: 15 * 60 * 1000,
    env: { PATH: CHILD_PATH, PNPM_CLI },
  });
  if (v.code === 0) return { ok: true };
  const tail = `${v.out}\n${v.err}`.trim().split('\n').filter(Boolean).slice(-25).join('\n');
  return {
    ok: false,
    detail: `独立门禁未通过（调度器自己跑的 bash scripts/verify.sh，不采信 agent 自述）：\n${tail}`,
  };
}

// 提交之后才能拿到 base...HEAD 的 diff，所以评审放在 commit 之后、push 之前。
function reviewAfterCommit(wt, base = 'origin/main', options = {}) {
  const r = reviewWorktree(wt, base, options);
  if (r.ok) return { ok: true, findings: r.findings };
  return { ok: false, detail: `评审层拒绝（改动未推送）：\n${formatFindings(r)}` };
}

async function runTask(issue, attempt = 1, priorFailure = '') {
  const n = issue.number;
  const tag = `[issue #${n}]${attempt > 1 ? `(第 ${attempt} 次)` : ''}`;
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  log(`${tag} 领取：${issue.title}`);

  const sections = parseSections(issue.body);
  const goal = pick(sections, '目标');
  const acceptance = pick(sections, '验收标准');
  const constraints = pick(sections, '约束');
  // 原始验收命令（可能带 ``` 围栏）：PLAN.md 里保留原样给人看，执行时再剥围栏。
  const acceptanceCmdsRaw = pick(sections, '验收命令');

  // 验收标准门禁：没有可执行验收标准就不启动
  if (!goal || !acceptance) {
    return failTask(issue, '缺少「目标」或「验收标准（可执行）」章节，拒绝执行。请按 Issue 模板补充后重新打 agent:ready。');
  }

  await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:working'] });

  const branch = `agent/issue-${n}`;
  const wt = path.join(WT_ROOT, `issue-${n}`);
  if (!existsSync(WT_ROOT)) mkdirSync(WT_ROOT, { recursive: true });

  try {
    await setupWorktree(branch, wt, 'origin/main');
    writePlan(wt, { n: issue.number, title: issue.title, goal, acceptance, constraints, cmds: acceptanceCmdsRaw });

    const mainBefore = (await git(['rev-parse', 'origin/main'])).out.trim();
    // 只读工单：查代码/审计类任务不该产生改动。提示词里先立规矩，
    // 否则 agent 会为了满足「必须有改动」的门禁去造 wrapper 脚本（PR #41 就是这样混出来的）。
    const readonly = (issue.labels ?? []).some((l) => l.name === 'readonly:ok');
    const prompt = buildPrompt({ n, title: issue.title, goal, acceptance, constraints, attempt, priorFailure, readonly });
    // 提示词落盘：重试时能直接看清调度器到底喂了 agent 什么（记忆库有没有生效）。
    try {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(path.join(LOG_DIR, `issue-${n}-attempt-${attempt}.prompt.md`), prompt);
    } catch { /* 日志写不了不影响任务本身 */ }

    if (DEBUG_FAIL && attempt <= DEBUG_FAIL) {
      throw new Error(`[debug] 强制第 ${attempt} 次尝试失败（DSH_DEBUG_FAIL_ATTEMPTS=${DEBUG_FAIL}）`);
    }

    // issue 打了 model:strong 就用强模型路由；复杂任务用 29B 容易漏改
    // 第一次用便宜模型，失败后升级：29B 在长推理任务上会撞 TPM 限流而停在计划阶段，
    // 与其让同一个弱模型重试三次，不如第二次就换 DeepSeek-V4.1-Flash。
    const forceStrong = (issue.labels ?? []).some((l) => l.name === 'model:strong');
    const useStrong = forceStrong || attempt > 1;
    // 改门禁脚本默认被评审层阻断，issue 打 allow:gate 才放行（人工在 issue 上表态）
    const allowGate = (issue.labels ?? []).some((l) => l.name === 'allow:gate');
    const runEnv = { PATH: CHILD_PATH };
    // 环境噪声（限流 / 进程没起来）时接着上一次的会话跑：省一次冷启动上下文，
    // 也不会在 ~/.dsh/sessions 下再堆一个目录。逻辑失败不复用，让它干净地重新想一遍。
    const prevSession = ISSUE_SESSION.get(n);
    const resumeId = prevSession && (prevSession.kind === 'llm-rate-limit' || prevSession.kind === 'headless-crash') ? prevSession.id : '';
    if (resumeId) runEnv.DSH_SESSION_ID = resumeId;
    if (useStrong) runEnv.DSH_HEADLESS_PATCH = STRONG_PATCH;

    const modelNote = useStrong ? (forceStrong ? ', model=strong' : ', model=strong(重试升级)') : '';
    log(`${tag} 启动 headless（cwd=${wt}${modelNote}）`);
    const t0 = Date.now();
    const r = await runHeadless(wt, prompt, runEnv, TIMEOUT);
    const sessionId = sessionIdOf(r.raw);
    if (sessionId) ISSUE_SESSION.set(n, { id: sessionId, kind: '' });
    const secs = Math.round((Date.now() - t0) / 1000);
    const usage = r.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 0 };
    const tail = (r.out || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
    log(`${tag} headless 结束 exit=${r.code} ${secs}s ${tail ? '→ ' + tail : ''}`);
    // token 用量：headless profile 不装 cost-meter，账本里没有这些 run，只能靠 --json 事件流自己记。
    if (r.usage && r.usage.steps) {
      log(`${tag} 消耗 ${formatUsage(r.usage)}`);
      try {
        if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
        appendFileSync(
          path.join(LOG_DIR, 'usage.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), issue: n, attempt, model: useStrong ? 'strong' : 'default', ...r.usage }) + NL,
        );
      } catch { /* 记账失败不影响任务本身 */ }
    }
    // 只留最后 3 行不够排障：完整输出落盘，事后能看清 agent 为什么什么都没做。
    try {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(path.join(LOG_DIR, `issue-${n}-attempt-${attempt}.log`),
        `exit=${r.code} ${secs}s\n===== stdout =====\n${r.out}\n===== stderr =====\n${r.err}\n`);
    } catch { /* 落盘失败不影响主流程 */ }
    const outTail = (r.out || '').trim().split('\n').filter(Boolean).slice(-12).join('\n');
    // 重试后仍然是 NTSTATUS：进程根本没起来，别让它走进「验收」流程（那会报错误的原因）。
    if (Number(r.code) >= 0xC0000000) {
      throw new Error(`[headless] headless-crash｜进程在启动阶段失败（exit=${r.code}），未产生任何改动`);
    }

    // agent 不应碰 origin/main。但并发跑时人（或另一个调度器）也可能在这期间合并了 main，
    // 所以不能只看「origin/main 变没变」——那会把别人的合法合并当成 agent 越界（#49 就这么被误杀过）。
    // 只有 main 的新 tip 长得像 agent 自己提交的（提交信息是我们的固定格式）才算越界。
    await git(['fetch', 'origin', 'main', '--quiet']);
    const mainAfter = (await git(['rev-parse', 'origin/main'])).out.trim();
    if (mainAfter !== mainBefore) {
      const tip = (await git(['log', '-1', '--format=%s', 'origin/main'])).out.trim();
      if (/^agent: (issue #\d+|fix CI for issue #\d+)/.test(tip)) {
        throw new Error(`agent 把提交推到了 origin/main（明确禁止），已中止：${tip}`);
      }
      log(`${tag} ℹ 任务期间 origin/main 前进（外部合并：${tip}），继续`);
    }

    const status = await worktreeStatus(wt);
    // 判「有没有干活」看的是文件变化，不是提交数：agent 为了绕开门禁会造空提交
    // （PR #40 就发生过），用 rev-list 计数会被它骗过去。
    const changedFiles = (await run(GIT, ['diff', '--name-only', 'origin/main...HEAD'], { cwd: wt })).out.trim();
    // 只读工单出现任何改动就是违约：不开 PR、不推送，改动清单进记忆库
    if (readonly && (status || changedFiles)) {
      const list = [changedFiles, status].filter(Boolean).join('\n').trim();
      recordFailure({ text: `[readonly] 只读工单产生了文件改动：\n${list}`, issue: n, attempt, reason: 'readonly-violation' }, FAIL_STORE);
      throw new Error(`[readonly] 只读工单（readonly:ok）却改动了文件，已中止且不开 PR：\n${list}\n只读工单只应回答结论，不应写文件。`);
    }
    if (!status && !changedFiles) {
      // 只读工单（查代码、做审计、回答问题）本来就不该产生改动。要求它改文件的门禁
      // 与「不要修改任何文件」的验收标准互斥，所以给一个显式出口：
      // issue 打 readonly:ok 时，把 agent 的结论贴成评论就算完成，不开 PR。
      if (readonly) {
        await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
        await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:ready')}`).catch(() => {});
        await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:done'] }).catch(() => {});
        await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
          body: `✅ 只读任务完成（未改动任何文件，按 readonly:ok 放行）\n\n${outTail.slice(-2000)}`,
        }).catch(() => {});
        log(`${tag} done（只读，无 PR）`);
        return;
      }
      const kind = headlessKind(r.out, r.err, r.code);
      throw new Error(`[headless] ${kind}｜agent 未产生任何改动（exit=${r.code}）\n输出尾部：\n${outTail.slice(-1500)}`);
    }

    // 1) 独立门禁：不接受作者自评
    const gate = await verifyWorktree(wt);
    if (!gate.ok) {
      recordFailure({ text: gate.detail, issue: n, attempt, reason: gate.detail }, FAIL_STORE);
      throw new Error(gate.detail);
    }

    // 可执行验收（issue 的 `### 验收命令`）：agent 自己写的测试只能自证，
    // 而这一段是提需求的人写的、agent 改不动，由调度器亲自跑一遍才算数。
    const acceptanceCmds = stripFence(acceptanceCmdsRaw);
    if (!acceptanceCmds) {
      // P0-6：没有验收命令的工单不进交付流程 —— 否则「做完了」全靠 agent 自述。
      // 例外：确实写不出可执行验收的工单，打 `acceptance:optional` 明确豁免。
      if (!labels.includes('acceptance:optional')) {
        const detail = 'issue 缺少 `### 验收命令` 段：调度器没有可执行的验收，不生成 PR（确需豁免请打 `acceptance:optional` 标签）';
        recordFailure({ text: detail, issue: n, attempt, reason: 'missing acceptance command' }, FAIL_STORE);
        throw new Error(detail);
      }
      log(`${tag} 没有验收命令，但工单标了 acceptance:optional，继续`);
    }
    let acceptanceVerdict = 'none';
    if (acceptanceCmds) {
      const res = await run(BASH, ['-lc', acceptanceCmds], {
        cwd: wt, timeout: 300_000, env: { PATH: CHILD_PATH, PNPM_CLI },
      });
      // 退出码 0 只说明「命令没崩」，不说明「验收过了」：有 VERDICT 行就以它为准。
      const decision = decideAcceptance(res, { strict: labels.includes('verdict:strict') });
      acceptanceVerdict = decision.verdict;
      const output = `${res.out ?? ''}\n${res.err ?? ''}`.trim();
      if (!decision.ok) {
        const detail = `验收未通过（${decision.detail}）：\n${acceptanceCmds}\n\n${output.slice(-2000)}`;
        recordFailure({ text: detail, issue: n, attempt, reason: 'acceptance command failed' }, FAIL_STORE);
        throw new Error(detail);
      }
      if (decision.verdict === 'unknown') log(`${tag} ⚠ ${decision.detail}`);
      log(`${tag} 验收命令通过（${acceptanceCmds.split('\n').length} 行，裁决=${decision.verdict}）`);
    }

    if (status) {
      // agent 有时会用 git add -f 把调度器自己写的 .dsh/PLAN.md 一起提交（实测 #64），
      // 那是内部笔记：从索引里摘掉，别让它进 PR，也别让评审团把它算成越界改动。
      await run(GIT, ['rm', '-r', '--cached', '--quiet', '.dsh'], { cwd: wt });
      await run(GIT, ['add', '-A'], { cwd: wt });
      const c = await run(GIT, ['-c', 'user.name=dsh-agent', '-c', 'user.email=agent@dsh.local',
        'commit', '-m', `agent: issue #${n}`], { cwd: wt });
      if (c.code !== 0) throw new Error(`commit 失败: ${c.err.trim()}`);
    }

    // 2) 评审层：机械判定，push 之前拦
    const review = reviewAfterCommit(wt, 'origin/main', { allowGate });
    if (!review.ok) {
      recordFailure({ text: review.detail, issue: n, attempt, reason: review.detail }, FAIL_STORE);
      throw new Error(review.detail);
    }
    const warns = (review.findings ?? []).filter((f) => f.severity === 'warn');

    // 3) 语义评审：机械规则只看 diff 的形状（删测试、漏 bless、动 workflows），
    // 看不出「代码写得像那么回事，但根本没满足验收标准」。这里请另一个家族的模型
    // 读验收标准 + 实际 diff；block 就把它的意见当成失败原因回灌给下一次重试。
    const diff = collectDiff(wt);
    const semT0 = Date.now();
    const semantic = diff.ok
      ? await reviewWithPanel({
        issueNumber: n, title: issue.title, goal, acceptance, constraints, diffText: diff.text, files: diff.files,
        acceptanceNote: acceptanceCmds ? `调度器已在本 worktree 里执行过验收命令，全部 exit 0：\n\`\`\`\n${acceptanceCmds}\n\`\`\`` : '',
      })
      : {
        ok: false,
        verdict: 'block',
        findings: [{ severity: 'block', rule: 'semantic-diff-failed', file: null, message: `拿不到 diff：${diff.error}` }],
        model: '-',
      };
    const semMs = Date.now() - semT0;
    log(`${tag} 语义评审：${formatSemantic(semantic).split('\n')[0]}（${Math.round(semMs / 1000)}s，${(diff.files ?? []).length} 个文件）`);
    if (semantic.paidUsed) {
      // 用户要求：评审一旦用到付费模型必须告知。三重留痕——日志、issue 评论、PR body。
      log(`${tag} ⚠ 语义评审切到付费面板（免费模型 ${semantic.freeModel} 不可用：${semantic.escalatedFrom}）`);
      try {
        await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
          body: [
            '⚠️ 这次语义评审用了**付费模型**。',
            '',
            `- 免费档模型：\`${semantic.freeModel}\``,
            `- 免费档不可用原因：${semantic.escalatedFrom}`,
            `- 实际使用的付费模型：${(semantic.reviewers ?? []).filter((r) => r.verdict !== 'skipped').map((r) => `\`${r.model}\``).join('、') || '（全部不可用）'}`,
            '',
            '这个原因反复出现就说明免费额度或凭证需要处理。',
          ].join(String.fromCharCode(10)),
        });
      } catch (e) {
        log(`${tag} ⚠ 付费切换的 issue 评论没发出去：${e.message}`);
      }
    }
    if (semantic.verdict === 'skipped') {
      // 放行但必须留痕：凭证失效/网络故障时这一层会静默消失，只有日志里一行就会没人发现。
      log(`${tag} ⚠ 语义评审未执行（这一层等于没有）：${semantic.skipped}`);
    }
    if (!semantic.ok) {
      const detail = `语义评审拒绝（改动未推送）：\n${formatSemantic(semantic)}`;
      recordFailure({ text: detail, issue: n, attempt, reason: detail.slice(0, 1500) }, FAIL_STORE);
      throw new Error(detail);
    }

    await pushWithRetry(wt, `${branch}:${branch}`);

    const pr = await api('POST', `/repos/${REPO}/pulls`, {
      title: `[agent] #${n} ${issue.title}`.slice(0, 250),
      head: branch,
      base: 'main',
      body: [
        `由调度器自动生成，对应 #${n}。`,
        '', '## 目标', goal, '', '## 验收标准', acceptance,
        '',
        '## 自动检查',
        `- 独立门禁 \`bash scripts/verify.sh\`：通过（调度器自己跑的，不采信 agent 自述）`,
        `- 评审层：通过${warns.length ? `，${warns.length} 条提示` : '，无问题'}`,
        ...warns.map((w) => `  - ⚠ [${w.rule}] ${w.message}${w.file ? `（${w.file}）` : ''}`),
        `- 语义评审：${formatSemantic(semantic).split(String.fromCharCode(10))[0]}${semantic.paidUsed ? `（⚠ 免费模型 ${semantic.freeModel} 不可用，已切付费）` : ''}`,
        `- 验收命令：${acceptanceCmds ? `已通过（${acceptanceCmds.split('\n').length} 行，调度器执行，裁决=${acceptanceVerdict}）` : 'issue 里没有给 `### 验收命令`（按 acceptance:optional 豁免）'}`,
        `- 验收命令：${acceptanceCmds ? `已通过（${acceptanceCmds.split('\n').length} 行，调度器执行，裁决=${acceptanceVerdict}）` : 'issue 里没有给 `### 验收命令`（按 acceptance:optional 豁免）'}`,
        `- 本次 agent 消耗：${formatUsage(usage)}`,
        ...(semantic.findings ?? []).map((f) => `  - ${f.severity === 'block' ? '✗' : '⚠'} [${f.rule}] ${f.message}${f.file ? `（${f.file}）` : ''}`),
        '',
        '## 需要人工确认（调度器不做）',
        '- 这份改动是否符合你真正想要的东西 —— 机器只能验「写了的东西对不对」，不能验「该不该写」。',
        '- 合并动作本身：本流水线不会自动 merge，也不会自动打 tag / 发版。',
        '- 若验收命令没有打印 `VERDICT: PASS`，说明这次只是「命令没崩」，人工要自己看一眼输出。',
        '', '---', 'CI 通过后请人工 review 再合并。',
      ].join('\n'),
    });
    let prUrl = pr.status === 201 ? pr.data.html_url : null;
    if (!prUrl) {
      const list = await api('GET', `/repos/${REPO}/pulls?head=${branch}&state=open`);
      prUrl = Array.isArray(list.data) ? list.data[0]?.html_url : null;
    }

    // 摘掉 ready/working，否则 label 状态会显示成「该 issue 还在排队」；
    // 虽然轮询过滤了 agent:done，但脏 label 会误导人，也挡不住手工重打 ready 时的重复执行。
    await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
    await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:ready')}`).catch(() => {});
    await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:done'] }).catch(() => {});
    await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
      body: `✅ 已生成 PR：${prUrl ?? '（PR 已存在但查询失败）'}\n\n耗时 ${secs}s。`,
    }).catch(() => {});
    log(`${tag} done → ${prUrl}`);
  } catch (e) {
    const reason = String(e?.stack || e);
    // 记下这一轮是不是环境噪声：下一轮据此决定要不要接着同一个会话跑。
    const kindHit = /\[headless\]\s*([a-z0-9-]+)/.exec(reason);
    if (kindHit && prevSession && prevSession.id) ISSUE_SESSION.set(n, { id: prevSession.id, kind: kindHit[1] });
  // 限流（429 / TPM limit reached）是环境噪声，不是这次改动的问题：等一会儿再来，
  // 而且**不消耗重试预算**——2026-10-26 实测三次 429 就把 #69 判了死，白丢一次任务。
  if (/llm-rate-limit|RATE_LIMIT: 429|TPM limit reached/.test(reason)) {
    const tries = RATE_LIMIT_RETRIES.get(n) ?? 0;
    if (tries < RATE_LIMIT_MAX) {
      RATE_LIMIT_RETRIES.set(n, tries + 1);
      const waited = Number(process.env.DSH_RATE_LIMIT_WAIT_MS ?? 120000);
      log(`${tag} 撞到限流，等 ${Math.round(waited / 1000)}s 后重试（第 ${tries + 1}/${RATE_LIMIT_MAX} 次，不计重试次数）`);
      await new Promise((r) => setTimeout(r, waited));
      return runTask(issue, attempt, reason);
    }
    log(`${tag} 限流重试 ${RATE_LIMIT_MAX} 次仍失败，按普通失败处理`);
  }
    // 失败指纹入仓：下次同类失败（哪怕换一张工单）能直接拿到这次的根因。
    try { recordFailure({ text: reason, issue: n, attempt, reason: reason.slice(0, 1500) }, FAIL_STORE); } catch { /* 记账失败不影响重试 */ }
    if (attempt < MAX_ATTEMPTS) {
      log(`${tag} 第 ${attempt}/${MAX_ATTEMPTS} 次失败，自动重试：${reason.split('\n')[0].slice(0, 180)}`);
      await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
        body: `⚠️ 第 ${attempt} 次执行失败，正在自动重试（上限 ${MAX_ATTEMPTS} 次）。\n\n\`\`\`\n${reason.slice(0, 1200)}\n\`\`\``,
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
      return runTask(issue, attempt + 1, reason);
    }
    await failTask(issue, `${MAX_ATTEMPTS} 次尝试均失败。\n\n最后一次错误：\n${reason}`);
  } finally {
    await locked(() => git(['worktree', 'remove', '--force', wt])).catch(() => {});
  }
}

// ---------- 轮询 ----------

// github.com 的 git 通道会间歇性重置连接（实测 push 报 `Recv failure: Connection was reset`，
// 几秒后重试就成功），所以 push 也要退避重试，不能一次失败就把整轮 rebase 判死。
async function pushWithRetry(cwd, refspec, extraArgs = []) {
  const backoff = [3000, 7000, 15000, 30000];
  let last = null;
  for (let i = 0; i <= backoff.length; i += 1) {
    last = await run(GIT, ['-c', 'credential.helper=', 'push', ...extraArgs, 'origin', refspec], { cwd, env: gitEnv() });
    if (last.code === 0) return;
    if (i < backoff.length) await new Promise((r) => setTimeout(r, backoff[i]));
  }
  if (networkError(last)) {
    log('[net] https 推不上去，改走 SSH 端点');
    const viaSsh = await run(GIT, ['-c', 'credential.helper=', 'push', ...extraArgs, SSH_REMOTE, refspec],
      { cwd, env: sshEnv() });
    if (viaSsh.code === 0) return;
    last = viaSsh;
  }
  throw new Error(`push 失败（退避重试 ${backoff.length + 1} 次 + SSH 端点）: ${last.err.trim().slice(0, 200)}`);
}

async function pollOnce() {
  const { data } = await api('GET', `/repos/${REPO}/issues?labels=${encodeURIComponent('agent:ready')}&state=open&per_page=20`);
  const issues = (Array.isArray(data) ? data : []).filter(
    (i) => !i.pull_request && !i.labels.some((l) => l.name === 'agent:working' || l.name === 'agent:done'),
  );
  if (issues.length === 0) {
    log('没有待处理任务');
    return 0;
  }
  log(`发现 ${issues.length} 个待处理任务（并发上限 ${CONCURRENCY}）`);
  await mapPool(issues, CONCURRENCY, async (issue) => {
    if (DRY) { log(`[dry-run] would run #${issue.number} ${issue.title}`); return; }
    await runTask(issue);
  });
  return issues.length;
}

// ---------- CI 失败回环 ----------
// agent 在 worktree 里自己跑 verify.sh 通过了，但云端 CI 仍可能因环境差异红掉。
// 这里监听 open PR 的 agent/* 分支，CI 失败就拉日志回灌给 agent 重修，上限 MAX_ATTEMPTS 次。

async function collectFailureLog(runId) {
  let text = '';
  try {
    const { data: jobs } = await api('GET', `/repos/${REPO}/actions/runs/${runId}/jobs`);
    for (const j of (jobs?.jobs ?? []).filter((x) => x.conclusion === 'failure')) {
      const failedSteps = (j.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name).join(', ');
      text += `### job: ${j.name}（失败步骤: ${failedSteps || '未知'}）\n`;
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${j.id}/logs`, {
        headers: { Authorization: `Bearer ${token()}`, 'User-Agent': 'dsh-dispatch' },
        redirect: 'follow',
      });
      if (r.ok) {
        const body = await r.text();
        text += body.slice(-6000) + '\n';
      } else {
        text += `(日志拉取失败 http=${r.status})\n`;
      }
    }
  } catch (e) {
    text += `(收集日志出错: ${e.message})\n`;
  }
  return text || '(CI 日志为空)';
}

async function repairCI(pr, issueN, runInfo) {
  const branch = pr.head.ref;
  const tag = `[issue #${issueN}][ci-retry]`;
  const wt = path.join(WT_ROOT, `issue-${issueN}-ci`);
  log(`${tag} CI 失败 run=${runInfo.id}，开始自动修复`);

  const logText = await collectFailureLog(runInfo.id);
  const t0 = Date.now();
  const prior = formatPriorFailures(logText, FAIL_STORE);
  const priorBlock = prior ? `\n## 历史同类失败（调度器记忆库）\n${prior}\n` : '';

  try {
    await setupWorktree(branch, wt, `origin/${branch}`);

    const prompt = `GitHub 云端 CI 在分支 ${branch} 上失败了（对应 issue #${issueN}）。注意：本地 verify.sh 可能是绿的，失败来自环境差异，必须先复现再修。
${priorBlock}

## 失败日志（尾部）
\`\`\`
${logText.slice(-8000)}
\`\`\`

## 要求
1. 先读仓库根目录的 AGENTS.md。
2. 在本地复现失败：运行 \`bash scripts/verify.sh\`。
3. 修复**根因**；禁止为了让 CI 变绿而放宽/删除测试断言，禁止改 .github/workflows/*，禁止新增依赖。
4. 修好后必须确认 \`bash scripts/verify.sh\` 通过。
5. 不要执行 git commit / git push —— 调度器会处理。
6. 不许留调试或占位代码。实测出现过：坏行 \`export const BROKEN = (\` 被「把括号补全」变成 \`export const BROKEN = 0;\` 而不是删掉——根因该删就删，别让它变合法留下来。

现在开始。`;

    const r = await runHeadless(wt, prompt, { PATH: CHILD_PATH }, TIMEOUT);
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`${tag} headless 结束 exit=${r.code} ${secs}s`);

    const status = await worktreeStatus(wt);
    if (!status) throw new Error('CI 修复未产生任何改动');

    const gate = await verifyWorktree(wt);
    if (!gate.ok) throw new Error(gate.detail);

    await run(GIT, ['add', '-A'], { cwd: wt });
    const c = await run(GIT, ['-c', 'user.name=dsh-agent', '-c', 'user.email=agent@dsh.local',
      'commit', '-m', `agent: fix CI for issue #${issueN}`], { cwd: wt });
    if (c.code !== 0) throw new Error(`commit 失败: ${c.err.trim()}`);

    // 修复提交同样过语义评审：CI 变绿不等于满足验收（修 CI 时很容易顺手把断言改弱）。
    const review = reviewAfterCommit(wt, 'HEAD~1');
    if (!review.ok) throw new Error(review.detail);

    const { data: issueData } = await api('GET', `/repos/${REPO}/issues/${issueN}`);
    const spec = parseSections(issueData?.body);
    const rdiff = collectDiff(wt, 'HEAD~1');
    const rsem = rdiff.ok
      ? await reviewWithPanel({
        issueNumber: issueN, title: issueData?.title ?? '',
        goal: pick(spec, '目标'), acceptance: pick(spec, '验收标准'), constraints: pick(spec, '约束'),
        diffText: rdiff.text, files: rdiff.files,
      })
      : {
        ok: false, verdict: 'block',
        findings: [{ severity: 'block', rule: 'semantic-diff-failed', file: null, message: `拿不到 diff：${rdiff.error}` }],
        model: '-',
      };
    log(`${tag} 语义评审：${formatSemantic(rsem).split('\n')[0]}（${(rdiff.files ?? []).length} 个文件）`);
    if (rsem.paidUsed) log(`${tag} ⚠ 语义评审切到付费面板（免费模型 ${rsem.freeModel} 不可用：${rsem.escalatedFrom}）`);
    if (!rsem.ok) throw new Error(`语义评审拒绝（修复未推送）：\n${formatSemantic(rsem)}`);

    await pushWithRetry(wt, `${branch}:${branch}`);

    await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
      body: `🔧 CI 失败自动修复完成（run ${runInfo.id}，耗时 ${secs}s），已推送新提交到 ${branch}。\n\n<!-- ci-retry-run:${runInfo.id} -->`,
    }).catch(() => {});
    log(`${tag} 修复完成 ${secs}s`);
  } catch (e) {
    try {
      recordFailure({ text: logText, issue: issueN, attempt: 1, reason: `CI 修复失败：${e.message}` }, FAIL_STORE);
    } catch { /* 记账失败不影响主流程 */ }
    await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
      body: `⚠️ CI 失败自动修复未成功：${String(e.message).slice(0, 800)}\n\n<!-- ci-retry-run:${runInfo.id} -->`,
    }).catch(() => {});
    log(`${tag} 修复失败: ${e.message}`);
  } finally {
    await locked(() => git(['worktree', 'remove', '--force', wt])).catch(() => {});
  }
}

// 分支落后 main 且真的冲突时，CI 那套修不了（推送前就 405）。自动 rebase 一次：
// 干净 rebase → force-with-lease 推回分支，CI 会重跑；真冲突 → 评论 + agent:failed 转人工。
// 冲突只落在基线文件时，正确解法不是挑一边：先取 main 的基线把 rebase 走完，
// 再在合并后的测试文件上跑 --bless 重算，最后把结果折进最后一个提交。
// 这样并行的 agent PR 不会因为「基线的数字不一样」互相卡死。
async function resolveBaselineOnlyRebase(wt, files) {
  const ours = await run(GIT, ['checkout', '--ours', '--', ...files], { cwd: wt });
  if (ours.code !== 0) return { ok: false, reason: `checkout --ours 失败：${ours.err.trim().slice(0, 200)}` };
  const add = await run(GIT, ['add', '--', ...files], { cwd: wt });
  if (add.code !== 0) return { ok: false, reason: `git add 失败：${add.err.trim().slice(0, 200)}` };
  const cont = await run(GIT, ['rebase', '--continue'], { cwd: wt, env: { ...process.env, GIT_EDITOR: 'true' } });
  if (cont.code !== 0) return { ok: false, reason: `rebase --continue 失败：${(cont.err || cont.out).trim().slice(0, 300)}` };
  const bless = await run(BASH, ['scripts/verify.sh', '--bless'], {
    cwd: wt,
    timeout: 15 * 60 * 1000,
    env: { PATH: CHILD_PATH, PNPM_CLI },
  });
  if (bless.code !== 0) {
    return { ok: false, reason: `重算基线时门禁未通过：${(bless.out + bless.err).trim().slice(-600)}` };
  }
  const status = await worktreeStatus(wt);
  if (status) {
    await run(GIT, ['add', '-A'], { cwd: wt });
    const amend = await run(GIT, ['commit', '--amend', '--no-edit'], { cwd: wt });
    if (amend.code !== 0) return { ok: false, reason: `基线重算后 amend 失败：${amend.err.trim().slice(0, 200)}` };
  }
  return { ok: true };
}

// 源码文件真冲突时，让 agent 来解一次：两边功能都要保留、基线重算、门禁通过。
// 只有它解不了才转人工——这样并行 PR 改同一个文件不会永远卡在人手上。
async function resolveConflictsWithAgent(wt, issueN, files) {
  const prompt = `分支 rebase 到最新 main 时发生了冲突，你只负责解决冲突，不要做别的功能改动。

冲突文件：${files.join(', ')}

## 要求
1. 先读仓库根目录的 AGENTS.md，了解门禁和禁止事项。
2. 运行 \`git rebase origin/main\`。冲突时逐个文件手工合并：**两边的功能都要保留**（main 上已有的函数/测试，本分支新增的函数/测试，一个都不许丢），不许为了让冲突消失而删掉任何一侧。
3. 解决后 \`git add <文件>\`，再 \`git -c core.editor=true rebase --continue\`；如果又出现冲突，继续同样处理，直到 rebase 完成。
4. rebase 完成后跑 \`bash scripts/verify.sh --bless\` 让基线跟上合并后的测试，再跑一次 \`bash scripts/verify.sh\` 确认通过。
5. 不要 \`git push\`、不要开 PR，调度器会处理。
6. 如果保留两边功能后确实无法解决，停下来，在输出里说明是哪个文件、为什么，不要硬删代码。

现在开始。`;

  const t0 = Date.now();
  // 解多文件源码冲突是这条流水线里最难的一步：29B 实测一次 41 秒成功、一次 522 秒失败，
  // 所以默认换强模型（可用 DSH_REBASE_MODEL=weak 退回旧行为）。
  const rebasePatch = process.env.DSH_REBASE_MODEL === 'weak' ? '' : STRONG_PATCH;
  const rebaseEnv = { PATH: CHILD_PATH };
  if (rebasePatch) rebaseEnv.DSH_HEADLESS_PATCH = rebasePatch;
  const r = await runHeadless(wt, prompt, rebaseEnv, REBASE_AGENT_TIMEOUT_MS);
  const secs = Math.round((Date.now() - t0) / 1000);
  // 解冲突是最容易「跑很久还没结论」的一步，输出必须留档，否则事后只剩一行 exit=1。
  const outPath = path.join(LOG_DIR, `issue-${issueN}-rebase.log`);
  try {
    writeFileSync(outPath, `# ${new Date().toISOString()} exit=${r.code} ${secs}s\n\n## stdout\n${r.out}\n\n## stderr\n${r.err}\n`);
  } catch { /* 留档失败不影响判定 */ }
  log(`[issue #${issueN}][rebase] 冲突解决 agent 结束 exit=${r.code} ${secs}s`);
  // 失败时把这行尾巴带进 issue 评论，人工接手不用再翻机器上的日志。
  const tail = `${(r.err || '').trim()}\n\n${(r.out || '').trim()}`.trim().slice(-800);

  const left = (await run(GIT, ['diff', '--name-only', '--diff-filter=U'], { cwd: wt })).out.trim();
  if (left) return { ok: false, tail, reason: `仍有未解决冲突：${left.replace(/\n/g, ', ')}` };

  const rebaseDir = (await run(GIT, ['rev-parse', '--git-path', 'rebase-merge'], { cwd: wt })).out.trim();
  if (rebaseDir && existsSync(path.resolve(wt, rebaseDir))) {
    return { ok: false, tail, reason: 'rebase 仍停在半途（agent 没有走完 rebase --continue）' };
  }

  const status = await worktreeStatus(wt);
  if (status) {
    await run(GIT, ['add', '-A'], { cwd: wt });
    const amend = await run(GIT, ['commit', '--amend', '--no-edit'], { cwd: wt });
    if (amend.code !== 0) return { ok: false, tail, reason: `解冲突后的改动 amend 失败：${amend.err.trim().slice(0, 200)}` };
  }
  return { ok: true };
}

async function rebaseAgentBranch(pr, issueN) {
  const branch = pr.head.ref;
  const wt = path.join(WT_ROOT, `issue-${issueN}-rebase`);
  const tmpBranch = `tmp/rebase-${issueN}`;
  const tag = `[issue #${issueN}][rebase]`;
  log(`${tag} 分支与 main 冲突，尝试自动 rebase`);
  try {
    await locked(async () => {
      await fetchWithRetry();
    });

    await locked(async () => {
      await git(['worktree', 'remove', '--force', wt]);
      await git(['branch', '-D', tmpBranch]);
      const add = await git(['worktree', 'add', wt, '-b', tmpBranch, `origin/${branch}`]);
      if (add.code !== 0) throw new Error(`worktree add 失败: ${add.err.trim()}`);
    });

    const rb = await run(GIT, ['rebase', 'origin/main'], { cwd: wt });
    if (rb.code !== 0) {
      const conflictsRaw = (await run(GIT, ['diff', '--name-only', '--diff-filter=U'], { cwd: wt })).out;
      const cls = classifyConflicts(conflictsRaw.split('\n'));

      // 只有基线文件冲突时，可以按合并后的测试重算，不需要人。
      if (cls.kind === 'baseline-only') {
        log(`${tag} 冲突只在基线文件（${cls.files.join(', ')}），按合并后的测试重算`);
        const resolved = await resolveBaselineOnlyRebase(wt, cls.files);
        if (resolved.ok) {
          log(`${tag} 基线已重算，继续跑门禁`);
        } else {
          await run(GIT, ['rebase', '--abort'], { cwd: wt }).catch(() => {});
          await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
            body: `⚠️ 分支 ${branch} 自动 rebase 时基线重算失败（${resolved.reason}），需人工处理。\n\n<!-- auto-rebase:${pr.head.sha} -->`,
          }).catch(() => {});
          await api('POST', `/repos/${REPO}/issues/${issueN}/labels`, { labels: ['agent:failed'] }).catch(() => {});
          log(`${tag} 基线重算失败，转人工：${resolved.reason.replace(/\n/g, ' ')}`);
          return;
        }
      } else {
        // 源码文件冲突：先让 agent 解一次（两边功能都要保留），解不了才转人工。
        const conflicts = cls.files.join(', ');
        await run(GIT, ['rebase', '--abort'], { cwd: wt }).catch(() => {});
        log(`${tag} 源码冲突（${conflicts}），交给 agent 解一次`);
        const resolved = await resolveConflictsWithAgent(wt, issueN, cls.files);
        if (!resolved.ok) {
          await run(GIT, ['rebase', '--abort'], { cwd: wt }).catch(() => {});
          await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
            body: `⚠️ 分支 ${branch} 与 main 冲突，自动 rebase 失败（冲突文件：${conflicts || '未知'}；${resolved.reason}），需人工处理。\n\n<details><summary>解冲突 agent 输出（末 800 字）</summary>\n\n\`\`\`\n${resolved.tail || '（无输出）'}\n\`\`\`\n\n</details>\n\n<!-- auto-rebase:${pr.head.sha} -->`,
          }).catch(() => {});
          await api('POST', `/repos/${REPO}/issues/${issueN}/labels`, { labels: ['agent:failed'] }).catch(() => {});
          log(`${tag} 冲突解决失败，转人工：${conflicts} / ${resolved.reason.replace(/\n/g, ' ')}`);
          return;
        }
        log(`${tag} 冲突已由 agent 解决，继续跑门禁`);
      }
    }

    const gate = await verifyWorktree(wt);
    if (!gate.ok) throw new Error(`rebase 后门禁未通过：${gate.detail.slice(0, 800)}`);

    await pushWithRetry(wt, `${tmpBranch}:${branch}`, ['--force-with-lease']);

    await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
      body: `🔄 分支 ${branch} 已自动 rebase 到最新 main，CI 会重跑。\n\n<!-- auto-rebase:${pr.head.sha} -->`,
    }).catch(() => {});
    log(`${tag} 自动 rebase 完成，已推送`);
  } catch (e) {
    log(`${tag} 自动 rebase 出错：${String(e.message).split('\n')[0]}`);
  } finally {
    await locked(() => git(['worktree', 'remove', '--force', wt])).catch(() => {});
  }
}

// GitHub 的 mergeable_state 是懒计算的：刚推送过、或它自己还没算完时返回 'unknown'，
// 靠它决定「要不要 rebase」会漏掉真实的冲突（实测 #52 挂了几小时一直是 dirty，调度器一次都没触发）。
// 所以自己做一次本地探测：fetch 分支后用 merge-tree 试合，冲突文件一目了然。
// headless 的进程链是 bash -> dsh.cmd -> Electron。实测偶发 0xC0000142（DLL 初始化失败）：
// 3 秒退出、stdout/stderr 全空、什么都没做。这是「进程没起来」，不该耗掉一次重试预算，
// 所以在这里原地重试几次；真的起不来才把 NTSTATUS 交给上层分类。
// 只放行与凭据无关的变量。agent 是被 issue 正文（不可信输入）驱动的，
// 它拿到的环境里不该有任何能推代码或调付费接口的密钥。
const SCRUB_ENV = /^(GIT_TOKEN|GIT_ASKPASS|GIT_SSH_COMMAND|GIT_SSH_VARIANT|GH_TOKEN|GITHUB_TOKEN|SILICONFLOW_API_KEY|ZHIPU_API_KEY|LEMONADE_HOME_API_KEY|HINDSIGHT_API_TOKEN|DEEPSEEK_API_KEY)$/i;
function scrubbedEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUB_ENV.test(k)) out[k] = v;
  return out;
}

async function runHeadless(cwd, prompt, env, timeout) {
  let last = null;
  for (let i = 1; i <= 3; i += 1) {
    // --json：stdout 是事件流，里面带每一步的 usage（headless profile 没装 cost-meter，
    // 账本里看不到这些 run，只能自己从事件流里累加）。
    last = await run(BASH, [path.join(REPO_DIR, 'ci/headless-task.sh'), '-'], { cwd, input: prompt, timeout, env: { ...scrubbedEnv(), DSH_INSTALL: INSTALL_DIR, ...env, DSH_HEADLESS_JSON: '1' }, clean: true });
    if (Number(last.code) < 0xC0000000) {
      const usage = sumUsage(last.out);
      return { ...last, raw: last.out, usage, out: finalText(last.out) };
    }
    log(`[headless] 子进程启动失败 exit=${last.code}（Windows NTSTATUS），5 秒后重试 ${i}/3`);
    if (i < 3) await new Promise((r) => setTimeout(r, 5000));
  }
  return last;
}

// 「agent 到底改了什么」的唯一入口：.dsh/PLAN.md 是调度器自己写的工作笔记（已加进 info/exclude），
// 万一 exclude 没生效也不能把它当成 agent 的改动——#60 就因此把一次进程崩溃误判成「干了活但验收失败」。
async function worktreeStatus(wt) {
  const out = (await run(GIT, ['status', '--porcelain'], { cwd: wt })).out;
  return out
    .split(NL)
    .filter((line) => line.trim() && !/(^|\s)\.dsh\//.test(line.trim()))
    .join(NL)
    .trim();
}

async function branchConflictFiles(branch) {
  const f = await git(['fetch', 'origin', branch, '--quiet']);
  if (f.code !== 0) return null; // 网络问题：这一轮先不判
  const r = await run(GIT, ['merge-tree', '--write-tree', '--name-only', 'origin/main', `origin/${branch}`], { cwd: REPO_DIR });
  if (r.code === 0) return [];
  // 第一行是合并后的 tree oid，之后是冲突文件；其它输出（例如 hint）忽略。
  return r.out
    .split('\n')
    .slice(1)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('CONFLICT') && !s.includes(' '));
}

async function checkAgentPRs() {
  const { data: prs } = await api('GET', `/repos/${REPO}/pulls?state=open&per_page=20`);
  const agentPrs = (Array.isArray(prs) ? prs : []).filter((pr) => /^agent\/issue-(\d+)$/.test(pr.head.ref));
  if (agentPrs.length) {
    const states = [];
    for (const pr of agentPrs) {
      const { data: d } = await api('GET', `/repos/${REPO}/pulls/${pr.number}`);
      states.push(`#${pr.number}:${d?.mergeable_state ?? 'unknown'}`);
    }
    log(`[prs] 打开 ${agentPrs.length} 个 agent PR：${states.join(' ')}`);
  }
  for (const pr of Array.isArray(prs) ? prs : []) {
    const m = /^agent\/issue-(\d+)$/.exec(pr.head.ref);
    if (!m) continue;
    const issueN = Number(m[1]);
    const { data: comments } = await api('GET', `/repos/${REPO}/issues/${issueN}/comments?per_page=100`);
    const list = Array.isArray(comments) ? comments : [];

    // 冲突分支：CI 修不了（推送前就 405），先尝试自动 rebase。
    // 同一个提交最多试 3 次——工具修好之后还有机会重试，但不会每分钟空转。
    const rebaseTries = list.filter((c) => c.body?.includes(`auto-rebase:${pr.head.sha}`)).length;
    const conflicts = await branchConflictFiles(pr.head.ref);
    if (conflicts && conflicts.length && rebaseTries < REBASE_MAX_TRIES) {
      await rebaseAgentBranch(pr, issueN);
      continue;
    }

    const { data: runs } = await api('GET', `/repos/${REPO}/actions/runs?branch=${encodeURIComponent(pr.head.ref)}&per_page=5`);
    const ci = ((runs?.workflow_runs) ?? []).find((r) => r.name === 'ci' && r.status === 'completed');
    // CI 绿 + 分支可合并时的出口：默认停下等人工合并（产品调研里没有一家自动合并），
    // 但工单打了 merge:auto 就按约定自动 squash 合并并关单——这是唯一一条「无人值守跑到底」的路径。
    if (ci && ci.conclusion === 'success') {
      const { data: issueData } = await api('GET', `/repos/${REPO}/issues/${issueN}`);
      const labels = (issueData?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
      const mergeState = (await api('GET', `/repos/${REPO}/pulls/${pr.number}`))?.data?.mergeable_state;
      if (!labels.includes('merge:auto')) {
        log(`[issue #${issueN}][prs] #${pr.number} CI 绿（${mergeState ?? 'unknown'}），等人工合并（未打 merge:auto）`);
        continue;
      }
      // ruleset 要求分支是最新的（strict_required_status_checks_policy），落后的 PR 即使 CI 绿也合不了：
      // 这类「behind」没有冲突文件，merge-tree 查不出来，只能在这里按状态补一次 rebase。
      if (mergeState === 'behind' && rebaseTries < REBASE_MAX_TRIES) {
        log(`[issue #${issueN}][prs] #${pr.number} 落后于 main（ruleset 要求最新），先 rebase`);
        await rebaseAgentBranch(pr, issueN);
        continue;
      }
      if (mergeState !== 'clean') {
        log(`[issue #${issueN}][prs] #${pr.number} CI 绿但不可合并（${mergeState ?? 'unknown'}），本轮不合并`);
        continue;
      }
      const merged = await api('PUT', `/repos/${REPO}/pulls/${pr.number}/merge`, {
        merge_method: 'squash',
        commit_title: `${issueData.title} (#${issueN})`,
      });
      if (!(merged.status >= 200 && merged.status < 300)) {
        log(`[issue #${issueN}][prs] 自动合并失败：${JSON.stringify(merged.data).slice(0, 200)}`);
        continue;
      }
      log(`[issue #${issueN}][prs] 已按 merge:auto 合并 #${pr.number} → ${String(merged.data.sha).slice(0, 7)}`);
      await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
        body: `✅ 已按 \`merge:auto\` 自动 squash 合并 PR #${pr.number}（commit ${String(merged.data.sha).slice(0, 7)}）。`,
      }).catch(() => {});
      await api('DELETE', `/repos/${REPO}/git/refs/heads/${pr.head.ref}`).catch(() => {});
      await api('PATCH', `/repos/${REPO}/issues/${issueN}`, { state: 'closed' }).catch(() => {});
      continue;
    }
    if (!ci || ci.conclusion !== 'failure') continue;
    if (list.some((c) => c.body?.includes(`ci-retry-run:${ci.id}`))) continue; // 这个 run 已处理过

    const attempts = list.filter((c) => c.body?.includes('CI 失败自动修复')).length;
    if (attempts >= MAX_ATTEMPTS) {
      await api('POST', `/repos/${REPO}/issues/${issueN}/labels`, { labels: ['agent:failed'] }).catch(() => {});
      await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
        body: `❌ CI 失败修复已达 ${MAX_ATTEMPTS} 次上限，需人工介入。\n\n<!-- ci-retry-run:${ci.id} -->`,
      }).catch(() => {});
      log(`[issue #${issueN}] CI 修复次数超限，转人工`);
      continue;
    }
    await repairCI(pr, issueN, ci);
  }
}

// 调度器重启后，上一个进程可能留下 agent:working 的孤儿 issue；启动时清掉，
// 否则这些 issue 会因为"正在执行"被永久跳过。
async function cleanupStaleWorking() {
  const { data } = await api('GET', `/repos/${REPO}/issues?labels=${encodeURIComponent('agent:working')}&state=open&per_page=50`);
  for (const i of Array.isArray(data) ? data : []) {
    if (i.pull_request || i.labels.some((l) => l.name === 'agent:done')) continue;
    await api('DELETE', `/repos/${REPO}/issues/${i.number}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
    log(`清理孤儿 agent:working → issue #${i.number}`);
  }
}

// 拉起脱离父进程的常驻 --serve。父进程退出后它继续跑（工具调用进程树被回收也不该带走它，
// 所以真正的补位动作交给计划任务里的 --once）。
function startResident() {
  const child = spawn(process.execPath, ['--use-system-ca', SELF, '--serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: REPO_DIR,
    env: { ...process.env, DSH_DISPATCH_CHILD: '1' },
  });
  child.unref();
  return child.pid;
}

async function main() {
  // --ensure：只负责「保证有一个人在跑」。要么报出已经有的那个，要么脱离父进程拉起一个
  // 常驻的 --serve。它自己不等任务、不持锁，所以登录自启/计划任务反复调用都安全。
  if (ENSURE) {
    const holder = lockHolder();
    if (holder) {
      console.log(`常驻调度器已在运行（pid=${holder.pid}，起于 ${holder.at}）`);
      return;
    }
    console.log(`已拉起常驻调度器（pid=${startResident()}）`);
    return;
  }

  // 计划任务每 5 分钟用 --once 敲门。--ensure 手动拉起的常驻进程挂在当前工具调用的进程树上，
  // 工具调用一结束就可能被回收（03:15 就是这样丢的），所以这里顺手补位：没有活着的常驻进程
  // 就拉起一个，然后让位给它轮询。补位失败才退回单轮执行。
  if (ONCE && !lockHolder()) {
    let pid = null;
    try {
      pid = startResident();
      log(`拉起常驻调度器（pid=${pid}），本轮交给它轮询`);
    } catch (e) {
      log(`拉起常驻调度器失败，本轮按单轮执行：${e.message}`);
    }
    if (pid) {
      await new Promise((r) => setTimeout(r, 1200));
      if (lockHolder()) return;
      log('常驻进程没拿到锁，本轮自己跑一遍');
    }
  }

  const lock = acquireLock();
  if (!lock.ok) {
    // 计划任务每 5 分钟拿 --once 来敲门，常驻进程在跑时不该刷日志
    if (!ONCE) log(`已有调度器在跑（pid=${lock.holder.pid} 起于 ${lock.holder.at}），本次直接退出`);
    return;
  }
  process.on('exit', lock.release);
  log(`调度器启动 repo=${REPO} mode=${ONCE ? 'once' : 'serve'} dry=${DRY} maxAttempts=${MAX_ATTEMPTS} pid=${process.pid}`);
  const pruned = pruneLogs();
  try {
    const archivedSessions = await pruneDeadSessions();
    if (archivedSessions) log(`归档 ${archivedSessions} 个已删 worktree 的会话（移到 sessions-archived/pipeline-old）`);
  } catch (e) { log(`会话归档跳过：${e.message}`); }
  if (pruned) log(`清理 ${pruned} 个超过 ${LOG_RETENTION_DAYS} 天的尝试日志`);
  if (!existsSync(ASKPASS)) throw new Error(`缺少 ${ASKPASS}`);
  await cleanupStaleWorking();
  await pollOnce();
  await checkAgentPRs();
  if (ONCE) return;
  while (true) {
    await new Promise((r) => setTimeout(r, INTERVAL));
    // 常驻进程要确认锁还是自己的：卡死超过 LOCK_STALE_MS 后会被别人接管，
    // 那时自己必须退出，不能变成两个调度器同时抢 worktree。
    if (!ownsLock()) {
      log(`锁已被接管（pid=${process.pid} 不再是持有者），常驻进程退出`);
      return;
    }
    // 心跳：每轮把锁的时间刷成现在。没有它，一个只是「闲了很久」的常驻进程会被别的进程
    // 判成陈旧锁接管，而它自己还在轮询——两边都以为自己是主人。
    try {
      writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } catch { /* 刷不动就等下一轮 */ }
    try {
      await pollOnce();
      await checkAgentPRs();
    } catch (e) { log(`轮询出错: ${e.message}`); }
  }
}

// 允许「只加载、不执行」：模块级错误（漏声明的常量、TDZ、拼错的导入）在 import 时就会炸，
// 而 `node --check` 只查语法，抓不到这类问题（2026-10-26 就因为删了一个 const 让 main 起不来）。
if (process.env.DSH_DISPATCH_LOAD_ONLY !== '1') {
  main().catch((e) => { console.error(e); process.exit(1); });
}
