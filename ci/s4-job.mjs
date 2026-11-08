#!/usr/bin/env node
// ci/s4-job.mjs —— 把一次 headless 任务交给低权用户跑，并把结果整理成和 run() 一样的形状。
//
// 为什么要有它：`ci/dispatch.mjs:1864` 现在是管理员身份直接 spawn `ci/headless-task.sh`，
// 低权隔离（S4）装好了也用不上。这个模块负责「写 job.json → 以 dsh-agent 启动 runner →
// 等 done.json → 读 headless.log」，dispatch 侧只需要一次函数调用。
//
// 返回形状与 dispatch 的 run() 对齐：{ code, out }（code = 任务退出码，out = 事件流全文），
// 另外多一个 done 字段带 verdict/tail/user，方便上层决定验收话术。
//
// CLI：
//   node ci/s4-job.mjs --task-file prompts/x.md --cwd D:\code\.worktrees\issue-7 --timeout 2400
//   node ci/s4-job.mjs --task "只回复 ok" --json
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
export const WORKTREE_ROOT = path.resolve(REPO, '..', '.worktrees');
// v3 P0（docs/89 §3.1）：jobDir 迁出工作区，落 ProgramData 并配 ACL。
// dsh-agent 必须能写自己的产物（done.json/headless.log 是 launcher 写的），所以目录给读写；
// 但落盘的 job.json（任务输入）单独 Deny 写——被测方改不了「要它做什么」。
export const JOBS_ROOT = process.env.DSH_JOBS_ROOT || 'C:\\ProgramData\\dsh-jobs';
export const DEFAULT_JOB_DIR = process.env.DSH_JOB_DIR || path.join(JOBS_ROOT, 'current');
const AGENT_USER = process.env.DSH_AGENT_USER || 'dsh-agent';

function looksLikeJobsRoot(dir) {
  const abs = path.resolve(dir);
  return abs.toLowerCase().startsWith(path.resolve(JOBS_ROOT).toLowerCase());
}

// 幂等；失败返回 ok:false 供上层判断（不抛，免得一次缺管理员权限就把整单打死）。
export function hardenJobDir(jobDir, jobFile = 'job.json') {
  if (!looksLikeJobsRoot(jobDir)) return { ok: false, skipped: true, why: '非 ProgramData jobDir，跳过 ACL' };
  const d = path.resolve(jobDir);
  const root = path.resolve(JOBS_ROOT);
  // 低权进程要能穿过 JOBS_ROOT 才能到 current/：根目录只给 SYSTEM/Administrator 时，
  // agent 打开 job.json 报 UnauthorizedAccessException（2026-11-08 22:53 实测）。
  // 只给根目录本身 RX，不下发继承；子目录由下面的 /inheritance:r 全量重设。
  const r = d.toLowerCase() !== root.toLowerCase() && existsSync(root)
    ? spawnSync('icacls', [root, '/grant', `${AGENT_USER}:(RX)`], { encoding: 'utf8' })
    : { status: 0 };
  const a = spawnSync('icacls', [d, '/inheritance:r',
    // M = Modify（含 FILE_TRAVERSE）。只给 RW 时低权进程打开 job.json 会因目录缺遍历位报
    // UnauthorizedAccessException（2026-11-08 实测「访问被拒绝」）；job.json 再单独 Deny W。
    '/grant:r', 'Administrator:(OI)(CI)F', 'SYSTEM:(OI)(CI)F', `${AGENT_USER}:(OI)(CI)M`],
  { encoding: 'utf8' });
  const target = path.join(d, jobFile);
  // 先删旧的 Deny 再重新加：每次 prepareJob 都 /deny 会累积出重复 ACE（实测同一条 4 份）。
  spawnSync('icacls', [target, '/remove:d', AGENT_USER], { encoding: 'utf8' });
  // 只 deny WriteData/AppendData，不用 (W)：icacls 的 (W) 展开含 SYNCHRONIZE，
  // 而 CreateFile(GENERIC_READ) 也要 SYNCHRONIZE，Deny 它会连带把读拒掉
  // （2026-11-08 实测：dsh-agent 有 Allow Modify 仍报「对 job.json 的访问被拒绝」）。
  const b = spawnSync('icacls', [target, '/deny', `${AGENT_USER}:(WD,AD)`], { encoding: 'utf8' });
  const ok = r.status === 0 && a.status === 0 && b.status === 0;
  return { ok, root: r.status, dir: a.status, file: b.status, err: ok ? '' : `${r.stderr || ''}${a.stderr || ''}${b.stderr || ''}`.trim() };
}

const STALE = ['done.json', 'headless.log', 'headless.err', 'task.txt', 'launcher.out', 'launcher.err'];

export function prepareJob({ task, cwd, timeoutSec = 2400, jobDir = DEFAULT_JOB_DIR, patch = '', env = null }) {
  if (!task || !String(task).trim()) throw new Error('task 为空');
  if (!cwd) throw new Error('缺 cwd');
  const abs = path.resolve(cwd);
  const rel = path.relative(WORKTREE_ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('cwd 不在 .worktrees 下: ' + abs);
  }
  if (!existsSync(abs)) throw new Error('cwd 不存在: ' + abs);
  mkdirSync(jobDir, { recursive: true });
  for (const f of STALE) rmSync(path.join(jobDir, f), { force: true });
  const job = { task: String(task), timeoutSec: Number(timeoutSec) || 2400, cwd: abs };
  // 模型路由只经 job 文件传（不走继承环境变量）：低权侧自己决定要不要用别的 patch。
  if (patch) job.patch = String(patch);
  // job.json 对低权 agent 可读，所以这里只放一次性变量（代理 token），不放真 key。
  if (env && typeof env === 'object') {
    const safe = {};
    for (const k of ['DSH_PROXY_TOKEN']) if (env[k]) safe[k] = String(env[k]);
    if (Object.keys(safe).length) job.env = safe;
  }
  writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
  // 落盘后立刻收 ACL：目录只给 Administrator/SYSTEM/agent 读写，job.json 对 agent Deny 写。
  hardenJobDir(jobDir);
  return job;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 同一个 jobDir 只能有一份活：两个 run 同时写会让 runner 抢 headless.log（实测 exit 2）。
// 调度器是单进程，进程内串行化就够；真要并发再按 worktree 分 jobDir。
let queue = Promise.resolve();

export function runAsAgent(opts) {
  const next = queue.then(() => runAsAgentOnce(opts), () => runAsAgentOnce(opts));
  queue = next.then(() => {}, () => {});
  return next;
}

async function runAsAgentOnce({
  task, cwd, timeoutSec = 2400, jobDir = DEFAULT_JOB_DIR, patch = '', env = null,
  launcher = path.join(HERE, 's4-as-agent.ps1'), onSpawn = null,
}) {
  const job = prepareJob({ task, cwd, timeoutSec, jobDir, patch, env });
  const doneFile = path.join(jobDir, 'done.json');

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-JobDir', jobDir],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  if (onSpawn) onSpawn(child);
  let launchOut = '';
  let launchErr = '';
  child.stdout.on('data', (d) => { launchOut += String(d); });
  child.stderr.on('data', (d) => { launchErr += String(d); });

  // 上限比任务自己的超时多给 3 分钟（runner 到点会 taskkill 掉进程树并写 done.json）
  const waitMs = (job.timeoutSec + 180) * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch { /* ignore */ }
  }, waitMs);

  const launcherExit = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  });
  clearTimeout(timer);

  // launcher 可能先于 runner 结束（它靠 done.json 判完成），这里再给 60s 余量
  const graceDeadline = Date.now() + 60_000;
  while (!existsSync(doneFile) && Date.now() < graceDeadline) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  const done = readJson(doneFile);
  const logFile = path.join(jobDir, 'headless.log');
  const out = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';

  if (!done) {
    return {
      ok: false,
      code: -1,
      out,
      done: null,
      error: timedOut
        ? `等 done.json 超时（${waitMs / 1000}s）`
        : `没有 done.json：launcher exit=${launcherExit} ${(launchErr || launchOut).slice(-400)}`.trim(),
      job,
    };
  }
  const code = typeof done.exit === 'number' ? done.exit : (done.ok ? 0 : 1);
  return {
    ok: done.ok === true,
    code,
    out,
    done,
    error: done.ok ? '' : (done.error || `headless exit=${code}`),
    job,
  };
}

async function main(argv) {
  const arg = (name, dflt = '') => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const has = (name) => argv.includes('--' + name);
  let task = arg('task');
  const taskFile = arg('task-file');
  if (!task && taskFile) task = readFileSync(taskFile, 'utf8');
  if (!task) {
    console.error('用法: node ci/s4-job.mjs (--task <文本> | --task-file <文件>) --cwd <worktree> [--timeout 2400] [--json]');
    return 2;
  }
  const r = await runAsAgent({
    task,
    cwd: arg('cwd', path.join(WORKTREE_ROOT, '.s4', 'sandbox')),
    timeoutSec: Number(arg('timeout', '2400')),
    jobDir: arg('job-dir', DEFAULT_JOB_DIR),
  });
  if (has('json')) {
    console.log(JSON.stringify({ ok: r.ok, code: r.code, error: r.error, done: r.done }, null, 2));
  } else {
    console.log(`user=${r.done?.user || '?'} task-exit=${r.code} ok=${r.ok} ${r.done?.verdict || ''}`.trim());
    if (r.error) console.log('error: ' + r.error);
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error('s4-job: ' + (e && e.message ? e.message : e));
    process.exit(2);
  });
}
