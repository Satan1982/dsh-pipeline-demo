#!/usr/bin/env node
/**
 * dispatch.mjs — GitHub Issues → DSH headless agent → PR
 *
 * 轮询带 `agent:ready` label 的 issue，在隔离 worktree 里让 headless agent 干活，
 * 通过后自动推分支并开 PR。人只负责写 issue 和 review/merge。
 *
 * 用法:
 *   node ci/dispatch.mjs --once     跑一轮就退出（适合本地验证）
 *   node ci/dispatch.mjs            持续轮询（默认 60s）
 *   node ci/dispatch.mjs --dry-run  只列出待办 issue，不执行
 *
 * 环境变量:
 *   DSH_REPO               owner/repo，默认 Satan1982/dsh-pipeline-demo
 *   DSH_POLL_INTERVAL      轮询秒数，默认 60
 *   DSH_TASK_TIMEOUT_MS    单任务超时，默认 30 分钟
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

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
const TIMEOUT   = Number(process.env.DSH_TASK_TIMEOUT_MS ?? 30 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.DSH_MAX_ATTEMPTS ?? 3);
// 仅用于验证重试状态机：前 N 次尝试强制失败，不真正调模型
const DEBUG_FAIL = Number(process.env.DSH_DEBUG_FAIL_ATTEMPTS ?? 0);
const ONCE      = process.argv.includes('--once');
const DRY       = process.argv.includes('--dry-run');
const INTERVAL  = Number(process.env.DSH_POLL_INTERVAL ?? 60) * 1000;

const GIT_ENV = { GIT_ASKPASS: ASKPASS, GIT_TOKEN: TOKEN, GIT_TERMINAL_PROMPT: '0' };

const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

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

const git = (args, opts = {}) => run(GIT, args, { cwd: REPO_DIR, ...opts });

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

function buildPrompt({ n, title, goal, acceptance, constraints, attempt = 1, priorFailure = '' }) {
  const retryBlock = priorFailure
    ? `\n## 上次失败原因（这是第 ${attempt} 次尝试，必须针对性修复，不要重复同样的错误）\n${String(priorFailure).slice(0, 3000)}\n`
    : '';
  return `你正在一个隔离的 git worktree 里工作。任务来自 GitHub Issue #${n}：${title}
${retryBlock}
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
    await git(['fetch', 'origin', 'main', '--quiet']);
    await git(['worktree', 'remove', '--force', wt]);
    await git(['branch', '-D', branch]);
    const add = await git(['worktree', 'add', wt, '-b', branch, 'origin/main']);
    if (add.code !== 0) throw new Error(`worktree add 失败: ${add.err.trim()}`);

    const mainBefore = (await git(['rev-parse', 'origin/main'])).out.trim();
    const prompt = buildPrompt({ n, title: issue.title, goal, acceptance, constraints, attempt, priorFailure });

    if (DEBUG_FAIL && attempt <= DEBUG_FAIL) {
      throw new Error(`[debug] 强制第 ${attempt} 次尝试失败（DSH_DEBUG_FAIL_ATTEMPTS=${DEBUG_FAIL}）`);
    }

    log(`${tag} 启动 headless（cwd=${wt}）`);
    const t0 = Date.now();
    const r = await run(BASH, [path.join(REPO_DIR, 'ci/headless-task.sh'), '-'], {
      cwd: wt, input: prompt, timeout: TIMEOUT,
      env: { PATH: process.env.PATH },
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    const tail = (r.out || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
    log(`${tag} headless 结束 exit=${r.code} ${secs}s ${tail ? '→ ' + tail : ''}`);

    // agent 不应碰 origin/main
    await git(['fetch', 'origin', 'main', '--quiet']);
    const mainAfter = (await git(['rev-parse', 'origin/main'])).out.trim();
    if (mainAfter !== mainBefore) {
      throw new Error('agent 修改了 origin/main（明确禁止），已中止。请检查 gh-push.sh 的使用。');
    }

    const status = (await run(GIT, ['status', '--porcelain'], { cwd: wt })).out.trim();
    const ahead = parseInt((await run(GIT, ['rev-list', '--count', 'origin/main..HEAD'], { cwd: wt })).out.trim() || '0', 10);
    if (!status && ahead === 0) throw new Error('agent 未产生任何改动');

    if (status) {
      await run(GIT, ['add', '-A'], { cwd: wt });
      const c = await run(GIT, ['-c', 'user.name=dsh-agent', '-c', 'user.email=agent@dsh.local',
        'commit', '-m', `agent: issue #${n}`], { cwd: wt });
      if (c.code !== 0) throw new Error(`commit 失败: ${c.err.trim()}`);
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
        '', '---', 'CI 通过后请人工 review 再合并。',
      ].join('\n'),
    });
    let prUrl = pr.status === 201 ? pr.data.html_url : null;
    if (!prUrl) {
      const list = await api('GET', `/repos/${REPO}/pulls?head=${branch}&state=open`);
      prUrl = Array.isArray(list.data) ? list.data[0]?.html_url : null;
    }

    await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:done'] }).catch(() => {});
    await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
      body: `✅ 已生成 PR：${prUrl ?? '（PR 已存在但查询失败）'}\n\n耗时 ${secs}s。`,
    }).catch(() => {});
    log(`${tag} done → ${prUrl}`);
  } catch (e) {
    const reason = String(e?.stack || e);
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
    await git(['worktree', 'remove', '--force', wt]).catch(() => {});
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
  log(`发现 ${issues.length} 个待处理任务`);
  for (const issue of issues) {
    if (DRY) { log(`[dry-run] would run #${issue.number} ${issue.title}`); continue; }
    await runTask(issue);
  }
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

  try {
    await git(['fetch', 'origin', branch, '--quiet']);
    await git(['worktree', 'remove', '--force', wt]);
    await git(['branch', '-D', branch]);
    const add = await git(['worktree', 'add', wt, '-b', branch, `origin/${branch}`]);
    if (add.code !== 0) throw new Error(`worktree add 失败: ${add.err.trim()}`);

    const prompt = `GitHub 云端 CI 在分支 ${branch} 上失败了（对应 issue #${issueN}）。注意：本地 verify.sh 可能是绿的，失败来自环境差异，必须先复现再修。

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

现在开始。`;

    const r = await run(BASH, [path.join(REPO_DIR, 'ci/headless-task.sh'), '-'], {
      cwd: wt, input: prompt, timeout: TIMEOUT, env: { PATH: process.env.PATH },
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`${tag} headless 结束 exit=${r.code} ${secs}s`);

    const status = (await run(GIT, ['status', '--porcelain'], { cwd: wt })).out.trim();
    if (!status) throw new Error('CI 修复未产生任何改动');

    await run(GIT, ['add', '-A'], { cwd: wt });
    const c = await run(GIT, ['-c', 'user.name=dsh-agent', '-c', 'user.email=agent@dsh.local',
      'commit', '-m', `agent: fix CI for issue #${issueN}`], { cwd: wt });
    if (c.code !== 0) throw new Error(`commit 失败: ${c.err.trim()}`);

    const push = await run(GIT, ['-c', 'credential.helper=', 'push', 'origin', `${branch}:${branch}`], { cwd: wt, env: GIT_ENV });
    if (push.code !== 0) throw new Error(`push 失败: ${push.err.trim()}`);

    await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
      body: `🔧 CI 失败自动修复完成（run ${runInfo.id}，耗时 ${secs}s），已推送新提交到 ${branch}。\n\n<!-- ci-retry-run:${runInfo.id} -->`,
    }).catch(() => {});
    log(`${tag} 修复完成 ${secs}s`);
  } catch (e) {
    await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
      body: `⚠️ CI 失败自动修复未成功：${String(e.message).slice(0, 800)}\n\n<!-- ci-retry-run:${runInfo.id} -->`,
    }).catch(() => {});
    log(`${tag} 修复失败: ${e.message}`);
  } finally {
    await git(['worktree', 'remove', '--force', wt]).catch(() => {});
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

async function main() {
  log(`调度器启动 repo=${REPO} once=${ONCE} dry=${DRY} maxAttempts=${MAX_ATTEMPTS}`);
  if (!existsSync(ASKPASS)) throw new Error(`缺少 ${ASKPASS}`);
  await cleanupStaleWorking();
  await pollOnce();
  await checkAgentPRs();
  if (ONCE) return;
  while (true) {
    await new Promise((r) => setTimeout(r, INTERVAL));
    try {
      await pollOnce();
      await checkAgentPRs();
    } catch (e) { log(`轮询出错: ${e.message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
