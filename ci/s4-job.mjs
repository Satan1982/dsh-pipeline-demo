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
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
// 多仓部署时每个仓有自己的 .worktrees（调度器按 DSH_WORKTREES 建树）；
// 这里必须用同一个根，否则低权侧会把合法 cwd 判成「不在 .worktrees 下」而拒绝干活。
export const WORKTREE_ROOT = path.resolve(process.env.DSH_WORKTREES || path.join(REPO, '..', '.worktrees'));
export const DEFAULT_JOB_DIR = path.join(WORKTREE_ROOT, '.s4', 'current');

const STALE = ['done.json', 'headless.log', 'headless.err', 'task.txt', 'launcher.out', 'launcher.err'];

export function prepareJob({ task, cwd, timeoutSec = 2400, jobDir = DEFAULT_JOB_DIR, patch = '' }) {
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
  writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
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
  task, cwd, timeoutSec = 2400, jobDir = DEFAULT_JOB_DIR, patch = '',
  launcher = path.join(HERE, 's4-as-agent.ps1'), onSpawn = null,
}) {
  const job = prepareJob({ task, cwd, timeoutSec, jobDir, patch });
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
