#!/usr/bin/env node
// 读 docs/specs/<slug>/tasks.md 的表格，把每个任务写成一张 GitHub issue（带依赖标签）。
//
// 用法：
//   node ci/plan.mjs ledger --dry      # 只打印会建哪些单（默认行为，安全）
//   node ci/plan.mjs ledger --create   # 真建单
//   node ci/plan.mjs ledger --graph    # 打印依赖树 + mermaid
//
// 依赖用标签表达：任务的「依赖」列写 T1,T2 → issue 上打 dep-on:T1、dep-on:T2；
// 调度器只在这些前置 issue 关闭后才开工（见 ci/dispatch.mjs 的 depsSatisfied）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('--'));
const DRY = !args.includes('--create');
const GRAPH = args.includes('--graph');
const REPO = process.env.DSH_REPO ?? 'Satan1982/dsh-pipeline-demo';
const TOKEN_FILE = process.env.DSH_GITHUB_TOKEN_FILE
  || path.join(path.dirname(ROOT), '.secrets', 'github-token.txt');

export function splitRow(line) {
  // 不能简单 split('|')：验收命令里的 `||`（布尔或）会把一格劈成两半，
  // 2026-10-27 就因此把 T1 的命令截断在 `if(s.income!==100`，bash 直接 exit=2。
  // 反引号里的竖线一律当普通字符。
  const cells = [];
  let cur = '';
  let inTick = false;
  for (const ch of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (ch === '`') { inTick = !inTick; cur += ch; continue; }
    if (ch === '|' && !inTick) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function parseTasks(md) {
  const tasks = [];
  for (const line of String(md).split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.length < 3) continue;
    if (/^(任务|task)$/i.test(cells[0])) continue;        // 表头
    if (/^-{2,}$/.test(cells[0].replace(/[: ]/g, ''))) continue; // 分隔线
    const id = cells[0].replace(/[`*]/g, '');
    if (!/^[A-Za-z]+\d+$/.test(id)) continue;
    const depsCell = cells[2] ?? '';
    const deps = depsCell.split(/[,，、]/).map((s) => s.trim().replace(/[`*]/g, ''))
      .filter((s) => s && !/^[-—–]$/.test(s));
    const rawCmd = (cells[3] ?? '').trim().replace(/^`+|`+$/g, '');
    tasks.push({ id, title: cells[1].replace(/[`*]/g, ''), deps, cmd: rawCmd });
  }
  return tasks;
}

export function topoLevels(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map();
  const visit = (id, seen = new Set()) => {
    if (level.has(id)) return level.get(id);
    if (seen.has(id)) throw new Error(`依赖成环：${[...seen, id].join(' -> ')}`);
    seen.add(id);
    const t = byId.get(id);
    if (!t) throw new Error(`依赖的任务不存在：${id}`);
    const lv = t.deps.length ? Math.max(...t.deps.map((d) => visit(d, seen))) + 1 : 0;
    seen.delete(id);
    level.set(id, lv);
    return lv;
  };
  for (const t of tasks) visit(t.id);
  return tasks.map((t) => ({ ...t, level: level.get(t.id) }));
}

export function graphText(tasks) {
  const leveled = topoLevels(tasks);
  const max = Math.max(...leveled.map((t) => t.level), 0);
  const lines = [];
  for (let lv = 0; lv <= max; lv += 1) {
    const row = leveled.filter((t) => t.level === lv);
    const tag = lv === max ? '集成' : lv === 0 ? '起点' : '并行';
    lines.push(`第 ${lv + 1} 层（${tag}）：` + row.map((t) => `${t.id} ${t.title}${t.deps.length ? `（等 ${t.deps.join(',')}）` : ''}`).join(' | '));
  }
  return lines.join('\n');
}

export function graphMermaid(tasks) {
  const lines = ['```mermaid', 'graph LR'];
  for (const t of tasks) {
    lines.push(`  ${t.id}["${t.id} ${t.title.replace(/"/g, "'")}"]`);
    for (const d of t.deps) lines.push(`  ${d} --> ${t.id}`);
  }
  lines.push('```');
  return lines.join('\n');
}

export function issueBody(slugName, t, maxTasks) {
  const NL = String.fromCharCode(10);
  return [
    `### 目标`,
    `${t.title}（规格：docs/specs/${slugName}/spec.md，设计：design.md）`,
    ``,
    `### 验收标准（可执行）`,
    `- 按 design.md 与 contracts/ 实现本任务，不夹带其它任务`,
    `- 下面这条命令必须通过（自己打印 VERDICT: PASS）`,
    ``,
    `### 验收命令`,
    '```bash',
    t.cmd || 'echo "VERDICT: FAIL 没写验收命令"',
    '```',
    ``,
    `### 约束`,
    `- 只改本任务相关文件；动手前先读 .dsh/PLAN.md 与 docs/specs/${slugName}/design.md`,
    `- 改动范围超出本任务就停下来说明，不要顺手改别的`,
    maxTasks ? `- 本批共 ${maxTasks} 个任务，你是 ${t.id}` : '',
  ].filter((s) => s !== undefined).join(NL);
}

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (!existsSync(TOKEN_FILE)) throw new Error(`找不到 token 文件：${TOKEN_FILE}`);
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

async function api(method, p, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-plan',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function ensureLabel(name) {
  const r = await api('POST', '/labels', { name, color: '1d76db', description: 'plan.mjs 依赖标签' });
  return r.status === 201 || r.status === 422;
}

async function main() {
  if (!slug) {
    console.error('用法：node ci/plan.mjs <spec-slug> [--dry|--create] [--graph]');
    process.exit(1);
  }
  const file = path.join(ROOT, 'docs', 'specs', slug, 'tasks.md');
  if (!existsSync(file)) {
    console.error(`没有 ${file}：先复制 docs/specs/_template/tasks.md 并按任务填好`);
    process.exit(1);
  }
  const tasks = parseTasks(readFileSync(file, 'utf8'));
  if (!tasks.length) {
    console.error('tasks.md 里没解析到任务行（应为 | T1 | 标题 | 依赖 | 命令 |）');
    process.exit(1);
  }
  if (GRAPH) {
    console.log(graphText(tasks));
    console.log();
    console.log(graphMermaid(tasks));
    return;
  }
  const created = [];
  for (const t of tasks) {
    const labels = ['agent:ready', ...t.deps.map((d) => `dep-on:${d}`)];
    const body = issueBody(slug, t, tasks.length);
    if (DRY) {
      console.log(`[dry] ${t.id} ${t.title} | 依赖=${t.deps.join(',') || '-'} | 标签=${labels.join(',')} | 命令=${t.cmd.slice(0, 60)}`);
      created.push({ id: t.id, number: null });
      continue;
    }
    for (const d of t.deps) await ensureLabel(`dep-on:${d}`);
    const r = await api('POST', '/issues', { title: `[${slug}/${t.id}] ${t.title}`, body, labels });
    if (r.status !== 201) { console.error(`建单失败 ${t.id}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`); process.exit(1); }
    console.log(`created #${r.data.number} ${t.id} ${t.title}`);
    created.push({ id: t.id, number: r.data.number });
  }
  if (DRY) console.log(`\n[dry] 共 ${tasks.length} 张单；去掉 --dry 换成 --create 才会真建。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
