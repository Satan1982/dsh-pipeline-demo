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
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fingerprint, recordFailure, formatPriorFailures } from './failures.mjs';
import { headlessKind } from './headless-kind.mjs';
import { reviewWorktree, formatFindings } from './review.mjs';
import { collectDiff, reviewSemantically, formatSemantic } from './semantic-review.mjs';

// Windows 上 Node 自带 CA 不含系统根证书，必须 --use-system-ca，否则 api.github.com 报
// "unable to verify the first certificate"。没有该 flag 时自重启补上。
if (!process.execArgv.includes('--use-system-ca')) {
  const r = spawnSync(process.execPath, ['--use-system-ca', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const REPO      = process.env.DSH_REPO ?? 'Satan1982/dsh-pipeline-demo';
const TOKEN     = readFileSync('D:/code/.secrets/github-token.txt', 'utf8').trim();
const GIT       = 'C:/Program Files/Git/cmd/git.exe';
const BASH      = 'C:/Program Files/Git/bin/bash.exe';
const ASKPASS   = 'D:/code/.secrets/askpass.sh';
const REPO_DIR  = 'D:/code/dsh-pipeline-demo';
const WT_ROOT   = 'D:/code/.worktrees';
const STRONG_PATCH = 'D:/code/.secrets/headless-model-strong.yml';
const TIMEOUT   = Number(process.env.DSH_TASK_TIMEOUT_MS ?? 30 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.DSH_MAX_ATTEMPTS ?? 3);
// 仅用于验证重试状态机：前 N 次尝试强制失败，不真正调模型
const DEBUG_FAIL = Number(process.env.DSH_DEBUG_FAIL_ATTEMPTS ?? 0);
const CONCURRENCY = Math.max(1, Number(process.env.DSH_CONCURRENCY ?? 2));
const ONCE      = process.argv.includes('--once');
const ENSURE    = process.argv.includes('--ensure');
const SELF      = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DRY       = process.argv.includes('--dry-run');
const INTERVAL  = Number(process.env.DSH_POLL_INTERVAL ?? 60) * 1000;

const GIT_ENV = { GIT_ASKPASS: ASKPASS, GIT_TOKEN: TOKEN, GIT_TERMINAL_PROMPT: '0' };

// 随包运行时根目录：.../dependencies/node/bin/node.exe 上溯三级才是 dependencies。
// 上溯两级会落到 .../dependencies/node，PNPM_CLI 随之指向不存在的 node/pnpm/bin。
const BUNDLE_DIR = path.dirname(path.dirname(path.dirname(process.execPath)));
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
const LOG_DIR = 'D:/code/dsh-pipeline-demo/.logs';
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

// ---------- 基础设施 ----------

async function api(method, p, body) {
  const r = await fetch(`https://api.github.com${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
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

function run(cmd, args, { cwd, env, timeout, input } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
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
    env: { ...GIT_ENV, ...(opts.env ?? {}) },
  });

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
    const f = await git(['fetch', 'origin', '--quiet']);
    if (f.code !== 0) throw new Error(`git fetch 失败: ${f.err.trim().slice(0, 200)}`);
    await git(['worktree', 'remove', '--force', wt]);
    await git(['branch', '-D', branch]);
    const add = await git(['worktree', 'add', wt, '-b', branch, baseRef]);
    if (add.code !== 0) throw new Error(`worktree add 失败: ${add.err.trim()}`);
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
  log(`${tag} 领取：${issue.title}`);

  const sections = parseSections(issue.body);
  const goal = pick(sections, '目标');
  const acceptance = pick(sections, '验收标准');
  const constraints = pick(sections, '约束');

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
    if (useStrong) runEnv.DSH_HEADLESS_PATCH = STRONG_PATCH;

    const modelNote = useStrong ? (forceStrong ? ', model=strong' : ', model=strong(重试升级)') : '';
    log(`${tag} 启动 headless（cwd=${wt}${modelNote}）`);
    const t0 = Date.now();
    const r = await run(BASH, [path.join(REPO_DIR, 'ci/headless-task.sh'), '-'], {
      cwd: wt, input: prompt, timeout: TIMEOUT,
      env: runEnv,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    const tail = (r.out || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
    log(`${tag} headless 结束 exit=${r.code} ${secs}s ${tail ? '→ ' + tail : ''}`);
    // 只留最后 3 行不够排障：完整输出落盘，事后能看清 agent 为什么什么都没做。
    try {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(path.join(LOG_DIR, `issue-${n}-attempt-${attempt}.log`),
        `exit=${r.code} ${secs}s\n===== stdout =====\n${r.out}\n===== stderr =====\n${r.err}\n`);
    } catch { /* 落盘失败不影响主流程 */ }
    const outTail = (r.out || '').trim().split('\n').filter(Boolean).slice(-12).join('\n');

    // agent 不应碰 origin/main
    await git(['fetch', 'origin', 'main', '--quiet']);
    const mainAfter = (await git(['rev-parse', 'origin/main'])).out.trim();
    if (mainAfter !== mainBefore) {
      throw new Error('agent 修改了 origin/main（明确禁止），已中止。请检查 gh-push.sh 的使用。');
    }

    const status = (await run(GIT, ['status', '--porcelain'], { cwd: wt })).out.trim();
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

    if (status) {
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
    const semantic = diff.ok
      ? await reviewSemantically({
        issueNumber: n, title: issue.title, goal, acceptance, constraints, diffText: diff.text,
      })
      : {
        ok: false,
        verdict: 'block',
        findings: [{ severity: 'block', rule: 'semantic-diff-failed', file: null, message: `拿不到 diff：${diff.error}` }],
        model: '-',
      };
    log(`${tag} 语义评审：${formatSemantic(semantic).split('\n')[0]}`);
    if (!semantic.ok) {
      const detail = `语义评审拒绝（改动未推送）：\n${formatSemantic(semantic)}`;
      recordFailure({ text: detail, issue: n, attempt, reason: detail.slice(0, 1500) }, FAIL_STORE);
      throw new Error(detail);
    }

    const push = await run(GIT, ['-c', 'credential.helper=', 'push', 'origin', `${branch}:${branch}`], { cwd: wt, env: GIT_ENV });
    if (push.code !== 0) throw new Error(`push 失败: ${push.err.trim()}`);

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
        `- 语义评审：${formatSemantic(semantic).split('\n')[0]}`,
        ...(semantic.findings ?? []).map((f) => `  - ${f.severity === 'block' ? '✗' : '⚠'} [${f.rule}] ${f.message}${f.file ? `（${f.file}）` : ''}`),
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
        headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'dsh-dispatch' },
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

    const r = await run(BASH, [path.join(REPO_DIR, 'ci/headless-task.sh'), '-'], {
      cwd: wt, input: prompt, timeout: TIMEOUT, env: { PATH: CHILD_PATH },
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`${tag} headless 结束 exit=${r.code} ${secs}s`);

    const status = (await run(GIT, ['status', '--porcelain'], { cwd: wt })).out.trim();
    if (!status) throw new Error('CI 修复未产生任何改动');

    const gate = await verifyWorktree(wt);
    if (!gate.ok) throw new Error(gate.detail);

    await run(GIT, ['add', '-A'], { cwd: wt });
    const c = await run(GIT, ['-c', 'user.name=dsh-agent', '-c', 'user.email=agent@dsh.local',
      'commit', '-m', `agent: fix CI for issue #${issueN}`], { cwd: wt });
    if (c.code !== 0) throw new Error(`commit 失败: ${c.err.trim()}`);

    // 修复本身也会写出脏东西（历史上出现过 BROKEN 占位行），所以修复提交同样过评审层
    const review = reviewAfterCommit(wt, 'HEAD~1');
    if (!review.ok) throw new Error(review.detail);

    const push = await run(GIT, ['-c', 'credential.helper=', 'push', 'origin', `${branch}:${branch}`], { cwd: wt, env: GIT_ENV });
    if (push.code !== 0) throw new Error(`push 失败: ${push.err.trim()}`);

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

async function checkAgentPRs() {
  const { data: prs } = await api('GET', `/repos/${REPO}/pulls?state=open&per_page=20`);
  for (const pr of Array.isArray(prs) ? prs : []) {
    const m = /^agent\/issue-(\d+)$/.exec(pr.head.ref);
    if (!m) continue;
    const issueN = Number(m[1]);

    const { data: runs } = await api('GET', `/repos/${REPO}/actions/runs?branch=${encodeURIComponent(pr.head.ref)}&per_page=5`);
    const ci = ((runs?.workflow_runs) ?? []).find((r) => r.name === 'ci' && r.status === 'completed');
    if (!ci || ci.conclusion !== 'failure') continue;

    const { data: comments } = await api('GET', `/repos/${REPO}/issues/${issueN}/comments?per_page=100`);
    const list = Array.isArray(comments) ? comments : [];
    if (list.some((c) => c.body.includes(`ci-retry-run:${ci.id}`))) continue; // 这个 run 已处理过

    const attempts = list.filter((c) => c.body.includes('CI 失败自动修复')).length;
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
    try {
      await pollOnce();
      await checkAgentPRs();
    } catch (e) { log(`轮询出错: ${e.message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
