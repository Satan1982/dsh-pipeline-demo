#!/usr/bin/env node
// Pass^3 真实工单：每个任务造 runs 个独立 issue 副本，逐个用 `dispatch --issue N` 单跑，
// 每个任务 runs/runs 通过才算 pass。这是真正的 agent 工单（走 S4 低权通道、真模型、真 PR），
// 不是 pass3.mjs 那种命令切片。
//
// 与常驻调度器共存：整个运行期间先 `--pause`（--issue 单跑不受暂停影响），跑完按前态恢复，
// 避免后台计划任务在副本刚建好、还没轮到单跑时把它们领走。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILOT_REPO } from './merge-policy.mjs';
import { readState } from './runtime-state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(HERE);
const LOG_DIR = process.env.DSH_LOG_DIR || path.join(REPO_DIR, '.logs');
const SECRETS_DIR = process.env.DSH_SECRETS_DIR || path.join(path.dirname(REPO_DIR), '.secrets');
const TOKEN_FILE = process.env.DSH_GITHUB_TOKEN_FILE || path.join(SECRETS_DIR, 'github-token.txt');
const REPO = process.env.DSH_REPO ?? PILOT_REPO;
const API = process.env.DSH_GITHUB_API || 'https://api.github.com';
const RESULT_FILE = path.join(REPO_DIR, 'ci', 'drills', 'pass3-issues-result.json');

const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
const TASKS_FILE = opt('--tasks', path.join(REPO_DIR, 'ci', 'drills', 'pass3-tasks.json'));
const RUNS = Math.max(1, Number(opt('--runs', '3')));
const ONLY = opt('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = argv.includes('--keep');
const DRY = argv.includes('--dry');
// 付费档：免费池限流时用 --paid 让每张单走 deepseek-flash（约 ¥0.1/单），保证全量测试速度。
const PAID = argv.includes('--paid');
const TIMEOUT_MS = Number(opt('--timeout', String(45 * 60 * 1000)));

function log(msg) { console.log(`[pass3-issues ${new Date().toISOString().slice(11, 19)}] ${msg}`); }

let TOKEN_CACHE = '';
function token() {
  if (!TOKEN_CACHE) TOKEN_CACHE = readFileSync(TOKEN_FILE, 'utf8').trim();
  return TOKEN_CACHE;
}

async function api(method, p, body) {
  const res = await fetch(API + p, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-pass3-issues',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error(`${method} ${p} -> ${res.status} ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

function issueBody(task) {
  return [
    `### 目标\n${task.goal}`,
    `### 验收标准\n${task.acceptance}`,
    `### 验收命令\n${task.cmds}`,
  ].join('\n\n');
}

function runDispatch(extra) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['ci/dispatch.mjs', ...extra], {
      cwd: REPO_DIR,
      // 付费档全量是测试开销，不该被日常 5 元日闸挡（2026-11-08 第一轮 22 单因 ¥5.02 到顶被跳过，
      // 白跑 30 分钟）。用户显式设了 DSH_DAY_MAX_CNY 就尊重之。
      env: { ...process.env, ...(PAID && !process.env.DSH_DAY_MAX_CNY ? { DSH_DAY_MAX_CNY: '20' } : {}) },
      stdio: 'inherit',
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, TIMEOUT_MS);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
    child.on('error', () => { clearTimeout(timer); resolve(1); });
  });
}

async function pause(reason) {
  const st = readState(LOG_DIR);
  if (st.paused) { log(`已经是暂停态（${st.pausedWhy || '未写原因'}），不重复下单`); return false; }
  await runDispatch(['--pause', '--why', reason]);
  log('已暂停队列领取（--issue 单跑不受影响）');
  return true;
}

async function resume() {
  await runDispatch(['--resume']);
  log('已恢复队列领取');
}

async function main() {
  if (!existsSync(TOKEN_FILE)) throw new Error(`缺少 token 文件：${TOKEN_FILE}`);
  const spec = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
  let tasks = Array.isArray(spec.tasks) ? spec.tasks : [];
  if (ONLY.length) tasks = tasks.filter((t) => ONLY.includes(t.id));
  if (!tasks.length) throw new Error('没有可跑的任务（检查 --tasks / --only）');
  for (const t of tasks) {
    for (const k of ['id', 'title', 'goal', 'acceptance', 'cmds']) {
      if (!t[k]) throw new Error(`任务 ${t.id || '?'} 缺字段 ${k}`);
    }
  }
  log(`仓库 ${REPO}；任务 ${tasks.length} 个 × ${RUNS} 次 = ${tasks.length * RUNS} 个 issue`);
  if (DRY) { log('--dry：只打印任务，不创建不运行'); for (const t of tasks) log(`  ${t.id} ${t.title}`); return; }

  const pausedByUs = await pause('Pass^3 真实工单运行中（pass3-issues.mjs）');
  const result = { at: new Date().toISOString(), repo: REPO, runs: RUNS, tasks: [], summary: {} };
  try {
    for (const task of tasks) {
      const entry = { id: task.id, title: task.title, runs: [] };
      for (let r = 1; r <= RUNS; r++) {
        const title = `[${task.id} r${r}] ${task.title}`;
        const issue = await api('POST', `/repos/${REPO}/issues`, {
          title, body: issueBody(task), labels: ['agent:ready', 'lane:standard', ...(PAID ? ['model:paid'] : [])],
        });
        log(`#${issue.number} 已创建：${title}`);
        const code = await runDispatch(['--once', '--issue', String(issue.number)]);
        // dispatch 退出 0 只说明「本轮跑完」：挂起（agent:blocked）也是 0。成功必须是 agent:done。
        const after = await api('GET', `/repos/${REPO}/issues/${issue.number}`);
        const names = (after.labels || []).map((l) => l.name);
        const ok = code === 0 && names.includes('agent:done') && !names.includes('agent:blocked');
        entry.runs.push({ run: r, issue: issue.number, exit: code, ok, labels: names.filter((x) => x.startsWith('agent:')) });
        log(`#${issue.number} 单跑结束 exit=${code}${ok ? ' PASS' : ` FAIL（${names.filter((x) => x.startsWith('agent:')).join(',') || '无状态标签'}）`}`);
        if (!KEEP) {
          await api('DELETE', `/repos/${REPO}/git/refs/heads/agent/issue-${issue.number}`).catch(() => {});
          await api('PATCH', `/repos/${REPO}/issues/${issue.number}`, { state: 'closed' }).catch(() => {});
        }
      }
      entry.passed = entry.runs.filter((x) => x.ok).length;
      entry.ok = entry.passed === RUNS;
      result.tasks.push(entry);
      log(`任务 ${task.id}：${entry.passed}/${RUNS}${entry.ok ? ' PASS^3' : ' FAIL'}`);
    }
  } finally {
    if (pausedByUs) await resume().catch((e) => log(`恢复失败：${e.message}`));
  }
  const passed = result.tasks.filter((t) => t.ok).length;
  const n = result.tasks.length;
  const p = passed / n;
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  result.summary = {
    tasks: n, passed, failed: n - passed, passRate: p,
    wilson95: [Math.max(0, (centre - half) / denom), Math.min(1, (centre + half) / denom)],
    totalRuns: n * RUNS,
  };
  mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + '\n');
  log(`结果：${passed}/${n} 任务 Pass^${RUNS}，总体 ${(p * 100).toFixed(1)}%，Wilson95 [${result.summary.wilson95.map((x) => (x * 100).toFixed(1)).join(', ')}]`);
  log(`明细写入 ${path.relative(REPO_DIR, RESULT_FILE)}`);
  process.exitCode = passed === n ? 0 : 1;
}

// Windows 上 Node 自带 CA 不含系统根证书：没有该 flag 时 fetch api.github.com 直接 "fetch failed"。
// 与 dispatch.mjs 同一套自重启做法。
if (!process.execArgv.includes('--use-system-ca')) {
  const r = spawnSync(process.execPath, ['--use-system-ca', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

main().catch((e) => { console.error(`[pass3-issues] 失败：${e.stack || e.message}`); process.exitCode = 1; });
