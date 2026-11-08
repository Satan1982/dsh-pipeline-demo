// v3 P2（docs/89 §3.5）：Pass^3 跑批入口。
//
// 用法：
//   node ci/pass3.mjs --tasks ci/drills/pass3-demo.json [--runs 3] [--json out.json] [--gate]
//
// 一个 task 的判定：同一命令在独立子进程里跑满 3 次、3 次全过才算 Pass^3。
// n < 36 时本工具只输出原始比例 + Wilson 区间（见 ci/metrics.mjs），不下 0.7 结论。
//
// 环境：只传最小变量（PATH/HOME/TMP 等），不把调度器凭据带进被测命令。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASS3_RUNS, summarizePass3 } from './metrics.mjs';

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BASH = process.env.DSH_BASH || 'bash';

function childEnv() {
  const keep = ['HOME', 'USERPROFILE', 'SystemRoot', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL'];
  const env = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  // 本机 PATH 里没有 node（随包 node 只按绝对路径用），而 manifest 里的命令写的是 `node ...`：
  // 把当前 node 的目录塞进 PATH，保证被测命令和 harness 用同一个解释器。
  const nodeDir = dirname(process.execPath);
  env.PATH = process.env.PATH ? `${nodeDir}${delimiter}${process.env.PATH}` : nodeDir;
  return env;
}

function runOnce(cmd, cwd, timeoutMs) {
  return new Promise((done) => {
    const p = spawn(BASH, ['-lc', cmd], { cwd, env: childEnv() });
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    let out = '';
    let err = '';
    let timedOut = false;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.end();
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, code: -1, out, err: `${err}${e.message}`, timedOut });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, code: code ?? -1, out, err, timedOut });
    });
  });
}

function parseArgs(argv) {
  const opts = { tasks: null, runs: PASS3_RUNS, json: null, gate: false, timeoutMs: 300_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--gate') { opts.gate = true; continue; }
    if (arg === '--tasks' || arg === '--json' || arg === '--runs' || arg === '--timeout-ms') {
      const value = argv[i + 1];
      if (value === undefined) throw new TypeError(`${arg} 需要取值`);
      i += 1;
      if (arg === '--tasks') opts.tasks = value;
      else if (arg === '--json') opts.json = value;
      else if (arg === '--runs') opts.runs = Number(value);
      else opts.timeoutMs = Number(value);
      continue;
    }
    throw new TypeError(`不认识的参数：${arg}`);
  }
  if (!opts.tasks) throw new TypeError('缺少 --tasks <manifest.json>');
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new TypeError('--runs 必须是正整数');
  return opts;
}

function loadTasks(file) {
  const parsed = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const list = Array.isArray(parsed) ? parsed : parsed.tasks;
  if (!Array.isArray(list) || list.length === 0) throw new TypeError(`${file} 里没有 tasks 数组`);
  for (const task of list) {
    if (!task || typeof task.id !== 'string' || typeof task.cmd !== 'string') {
      throw new TypeError(`${file} 的 task 需要 { id, cmd }：${JSON.stringify(task)}`);
    }
  }
  return list;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const tasks = loadTasks(opts.tasks);
  const results = [];
  for (const task of tasks) {
    const runs = [];
    for (let r = 0; r < opts.runs; r += 1) {
      const res = await runOnce(task.cmd, task.cwd ? resolve(task.cwd) : REPO_DIR, opts.timeoutMs);
      runs.push(res.ok);
      const mark = res.ok ? 'PASS' : `FAIL(exit=${res.code}${res.timedOut ? ',timeout' : ''})`;
      console.log(`[pass3] ${task.id} run ${r + 1}/${opts.runs}: ${mark}`);
      if (!res.ok) console.log(`${(res.err || res.out).trim().split('\n').slice(-8).join('\n')}`);
    }
    results.push({ id: task.id, cmd: task.cmd, runs });
  }
  const summary = summarizePass3(results, { runs: opts.runs });
  console.log(`[pass3] ${summary.verdict}`);
  if (summary.incomplete.length) console.log(`[pass3] 未跑满 ${opts.runs} 次：${summary.incomplete.join(', ')}`);
  if (opts.json) {
    writeFileSync(resolve(opts.json), `${JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2)}\n`, 'utf8');
    console.log(`[pass3] 结果已写入 ${opts.json}`);
  }
  if (opts.gate && summary.pass3 !== summary.n) return 1;
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
