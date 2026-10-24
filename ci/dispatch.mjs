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

function buildPrompt({ n, title, goal, acceptance, constraints }) {
  return `你正在一个隔离的 git worktree 里工作。任务来自 GitHub Issue #${n}：${title}

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
  await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:failed'] }).catch(() => {});
  await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
    body: `❌ 调度器执行失败：\n\n\`\`\`\n${r}\n\`\`\`\n\n处理完后去掉 \`agent:failed\`、重新加 \`agent:ready\` 即可重试。`,
  }).catch(() => {});
}

async function runTask(issue) {
  const n = issue.number;
  const tag = `[issue #${n}]`;
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
    const prompt = buildPrompt({ n, title: issue.title, goal, acceptance, constraints });

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
    await failTask(issue, e?.stack || String(e));
  } finally {
    await git(['worktree', 'remove', '--force', wt]).catch(() => {});
    await git(['branch', '--unmerged', branch]).catch(() => {});
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

async function main() {
  log(`调度器启动 repo=${REPO} once=${ONCE} dry=${DRY}`);
  if (!existsSync(ASKPASS)) throw new Error(`缺少 ${ASKPASS}`);
  await pollOnce();
  if (ONCE) return;
  while (true) {
    await new Promise((r) => setTimeout(r, INTERVAL));
    try { await pollOnce(); } catch (e) { log(`轮询出错: ${e.message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
