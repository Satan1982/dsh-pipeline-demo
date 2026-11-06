#!/usr/bin/env node
// ci/s4-concurrency-check.mjs —— S4 通道的并发/失败语义自检（不建 issue、不调模型）。
//
// 三条断言，全部用 ci/s4-stub-launcher.ps1 作替身，跑一次约 10 秒：
//   A 排队：同进程两单并发 → 串行（第二单在第一单之后才写 done.json），各写各的 jobDir。
//   B 失败不上报成通道故障：任务自身失败（done.json exit≠0）必须原样返回 done，不能变成 done=null。
//   C 重投：同一 jobDir 第二单必须只看自己的 task（prepareJob 清 stale），读到上一单的 done 就是串了。
//
// 用法：node ci/s4-concurrency-check.mjs [--json]   （exit 0 = 全过）
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsAgent, WORKTREE_ROOT } from './s4-job.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, 's4-stub-launcher.ps1');
const BASE = path.join(WORKTREE_ROOT, '.s4');
const SANDBOX = path.join(BASE, 'check-sandbox');

function done(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'done.json'), 'utf8'));
  } catch {
    return null;
  }
}

function fresh(name) {
  const dir = path.join(BASE, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
}

// A 排队：两单不同 jobDir，替身各睡 2.5 秒；串行时两单完成时刻相差 ≥2 秒。
{
  mkdirSync(SANDBOX, { recursive: true });
  process.env.S4_STUB_SLEEP = '2500';
  const da = fresh('check-queue-a');
  const db = fresh('check-queue-b');
  const t0 = Date.now();
  const mk = (tag, dir) => runAsAgent({
    task: 'queue-' + tag, cwd: SANDBOX, timeoutSec: 120, jobDir: dir, launcher: STUB,
  }).then((r) => ({ tag, r, end: Date.now() - t0 }));
  const [a, b] = await Promise.all([mk('a', da), mk('b', db)]);
  const gap = Math.abs(a.end - b.end);
  const taskA = done(da)?.task;
  const taskB = done(db)?.task;
  check(
    'A 排队串行且目录隔离',
    a.r.ok && b.r.ok && gap >= 2000 && taskA === 'queue-a' && taskB === 'queue-b',
    { endA: a.end, endB: b.end, gap, taskA, taskB },
  );
  rmSync(da, { recursive: true, force: true });
  rmSync(db, { recursive: true, force: true });
  delete process.env.S4_STUB_SLEEP;
}

// B 任务失败原样上报：替身写 exit=7，返回必须是 done≠null 且 ok=false、code=7。
{
  const d = fresh('check-fail');
  process.env.S4_STUB_FAIL = '1';
  const r = await runAsAgent({ task: 'fail-case', cwd: SANDBOX, timeoutSec: 120, jobDir: d, launcher: STUB });
  check(
    'B 任务失败不伪装成通道不可用',
    r.done !== null && r.ok === false && r.code === 7 && r.error === 'stub failure',
    { doneIsNull: r.done === null, ok: r.ok, code: r.code, error: r.error },
  );
  delete process.env.S4_STUB_FAIL;
  rmSync(d, { recursive: true, force: true });
}

// C 同 jobDir 重投：第一单失败、第二单成功，第二次的 done.json 与 task.txt 必须是第二单的。
{
  const d = fresh('check-retry');
  process.env.S4_STUB_FAIL = '1';
  const r1 = await runAsAgent({ task: 'attempt-1', cwd: SANDBOX, timeoutSec: 120, jobDir: d, launcher: STUB });
  delete process.env.S4_STUB_FAIL;
  const r2 = await runAsAgent({ task: 'attempt-2', cwd: SANDBOX, timeoutSec: 120, jobDir: d, launcher: STUB });
  // task.txt 是 runner 写的，替身只写 done.json；所以「残留被清」看 done.json 里是谁的结果。
  const d2 = done(d);
  const fresh2 = Boolean(d2 && d2.task === 'attempt-2' && d2.exit === 0);
  check(
    'C 重投清掉上一单的残留',
    r1.ok === false && r1.code === 7 && r2.ok === true && r2.code === 0 && fresh2,
    { r1: { ok: r1.ok, code: r1.code }, r2: { ok: r2.ok, code: r2.code }, doneTask: d2?.task, doneExit: d2?.exit },
  );
  rmSync(d, { recursive: true, force: true });
}

const pass = results.every((r) => r.pass);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ pass, results }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name} ${JSON.stringify(r.detail)}`);
  }
  console.log(pass ? '== S4 CONCURRENCY CHECK OK ==' : '== S4 CONCURRENCY CHECK FAILED ==');
}
process.exit(pass ? 0 : 1);
