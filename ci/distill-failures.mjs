#!/usr/bin/env node
// 把 docs/failures.jsonl 里的失败指纹蒸馏成一份摘要，写进 Hindsight 记忆库。
//
// 为什么需要它：指纹库只在「本机这个仓库」里滚，换一台机器、换一个仓库就重新踩同样的坑。
// Hindsight 是三台机器共享的长期记忆，把它当成跨机器的「踩坑知识」落点。
//
// 用法：
//   node ci/distill-failures.mjs            # 打印摘要并写入 Hindsight
//   node ci/distill-failures.mjs --dry      # 只打印，不写
//   node ci/distill-failures.mjs --top 20   # 多取几条
//   node ci/distill-failures.mjs --bank coding-agent::code
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classifyCause } from './failures.mjs';
import { readPoolSnapshot, renderPoolTrend } from './pool-trend.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORE = process.env.DSH_FAILURES_STORE || path.join(ROOT, 'docs/failures.jsonl');
const CLIENT = process.env.DSH_HINDSIGHT_CLIENT || path.join(homedir(), '.hindsight/coding-agent.json');

// 客户端配置由 Hindsight 插件维护，插件重写配置时会丢掉 apiToken 等未知键；
// 调度器又用 scrubbedEnv 启动子进程，继承来的 HINDSIGHT_API_TOKEN 进不来。
// 因此 token 解析按「配置 → 进程 env → 用户级 env（注册表）」兜底，任何一步都只用于发请求，不打印。
function readClient() {
  try {
    return JSON.parse(readFileSync(CLIENT, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
}

function userEnv(name) {
  if (process.platform !== 'win32') return '';
  const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return '';
  const line = (r.stdout || '').split(/\r?\n/).find((l) => /REG_(?:EXPAND_)?SZ\s+\S/.test(l));
  const m = line && line.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/);
  return m ? m[1] : '';
}

function resolveToken(cfg) {
  return cfg.apiToken || process.env.HINDSIGHT_API_TOKEN || userEnv('HINDSIGHT_API_TOKEN');
}

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const FORCE = args.includes('--force');
const pickFlag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const TOP = Number(pickFlag('--top', 12));

export function readStore(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function group(records) {
  const byFp = new Map();
  for (const r of records) {
    const fp = r.fp || 'unknown';
    const cur = byFp.get(fp) || { fp, count: 0, reason: '', issues: new Set(), fix: '', last: '', cause: classifyCause(r.reason || r.sig || '') };
    cur.count += 1;
    if (r.reason) cur.reason = r.reason;
    if (r.fix) cur.fix = r.fix;
    if (r.issue) cur.issues.add(r.issue);
    if (r.at && r.at > cur.last) cur.last = r.at;
    byFp.set(fp, cur);
  }
  return [...byFp.values()].sort((a, b) => b.count - a.count || (a.last < b.last ? 1 : -1));
}

// 记录里带着调用栈（`at runTask (file:///D:/...)`），对人类没信息量还夹着本机路径，
// 摘要把它们剪掉，只留第一句现象。
export function clean(text, max = 300) {
  const kept = String(text || '')
    .split('\n')
    .filter((line) => !/^\s+at\s/.test(line) && !line.includes('node:internal'));
  return kept.join(' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function render(groups, { pool = null, poolBad = 0, poolProblem = null } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# 自动化编程流水线 · 失败指纹摘要（${today}）`,
    '',
    '来源：dsh-pipeline-demo 的 docs/failures.jsonl（调度器每次失败都会记一条，按根因归并）。',
    '用途：换机器/换仓库时先查这里，别重新踩。',
    '',
  ];
  if (!groups.length) {
    // 没有失败也要出这份摘要：池子健康恰恰是在「没有失败」的日子里悄悄变差的。
    lines.push('过去这段时间没有失败指纹记录。', '');
  } else {
    lines.push(`共 ${groups.length} 个根因，取出现次数最多的 ${Math.min(TOP, groups.length)} 条：`, '');
  }
  // 先说清「栽在哪」：环境/基线类失败改机器就能消掉，不归因到它，代码再怎么修都白修。
  // 归因取每个根因「第一次」的判定（原发失败），不用最后一次的尾巴——尾巴常被后续输出带偏。
  const byCause = new Map();
  for (const g of groups) {
    const c = g.cause ?? classifyCause(g.reason);
    byCause.set(c, (byCause.get(c) ?? 0) + g.count);
  }
  const causeLine = [...byCause.entries()].map(([c, n]) => `${c} ${n}`).join(' / ');
  if (causeLine) lines.push(`按归因（记录条数）：${causeLine}`, '');
  for (const g of groups.slice(0, TOP)) {
    lines.push(`## ${g.count} 次 · 指纹 ${g.fp}`);
    lines.push(`- 现象：${clean(g.reason) || '（未记录原因）'}`);
    if (g.fix) lines.push(`- 修法：${clean(g.fix)}`);
    if (g.issues.size) lines.push(`- 相关工单：${[...g.issues].map((n) => `#${n}`).join(' ')}`);
    lines.push(`- 最近一次：${g.last || '未知'}`);
    lines.push('');
  }
  const poolText = renderPoolSection(pool, { bad: poolBad, problem: poolProblem });
  if (poolText) lines.push(poolText);
  return lines.join('\n').trim() + '\n';
}

/**
 * 池子健康段（单独成文，进自己的 bank）。
 * 独立出来是因为它写进 `pipeline::failures` 会被当成「当前可用性」检索；
 * 而且它统计的是历史，不是失败知识。
 */
export function renderPoolSection(trend, { bad = 0, problem = null } = {}) {
  const text = renderPoolTrend(trend, { bad });
  if (text) return text;
  if (problem) {
    return [
      '## 免费模型池健康（快照不可用）',
      '',
      '> 这是历史统计，不是当前可用性。',
      '',
      `- ${problem}`,
      '',
    ].join('\n');
  }
  return '';
}

async function post(text, bank) {
  const cfg = readClient();
  const auth = resolveToken(cfg);
  if (!auth) throw new Error('[distill] 缺少 Hindsight 凭据：配置无 apiToken，User 环境也没有 HINDSIGHT_API_TOKEN');
  const base = (cfg.apiUrl || 'http://127.0.0.1:9077').replace(/\/$/, '');
  const url = `${base}/v1/default/banks/${encodeURIComponent(bank)}/memories`;
  const body = {
    items: [{ content: text, context: 'pipeline-failures', tags: ['pipeline', 'failures'] }],
    async: true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, body: raw.slice(0, 300) };
}

async function main() {
  const records = readStore(STORE);
  // 池子趋势与失败指纹一起发：只有失败才有信号的话，池子是「先坏很久才崩」的。
  // 池子快照先读（调度器会先写快照再蒸馏，见 ci/dispatch.mjs），两份摘要分开发：
  // 失败指纹 → pipeline::failures；池子统计 → pipeline::pool（历史统计，不该被当成当前可用性检索）。
  const { trend: pool, bad: poolBad, problem: poolProblem } = readPoolSnapshot();
  if (poolProblem) console.error(`[distill] 池子快照有问题：${poolProblem}`);
  const failuresText = render(group(records));
  const poolText = renderPoolSection(pool, { bad: poolBad, problem: poolProblem });
  if (!records.length && !poolText) {
    console.error(`[distill] ${STORE} 里没有失败记录，池子快照也没有数据，无事可做。`);
    process.exit(0);
  }
  if (records.length) console.log(failuresText);
  if (poolText) console.log(poolText);

  if (DRY) {
    console.error('[distill] --dry：只打印，没有写入 Hindsight。');
    process.exit(0);
  }
  // 默认写独立 bank：踩坑知识跨仓库通用，混进某个仓库的 coding bank 反而不好检索。
  const bank = pickFlag('--bank', process.env.DSH_HINDSIGHT_BANK || 'pipeline::failures');
  const poolBank = pickFlag('--pool-bank', process.env.DSH_POOL_BANK || 'pipeline::pool');
  if (records.length && !FORCE && !bank) {
    console.error('[distill] 没有 bank（cod-agent.json 里也没有 bankId），用 --bank 指定。');
    process.exit(1);
  }
  const jobs = [];
  if (records.length) jobs.push(['失败摘要', failuresText, bank]);
  if (poolText) jobs.push(['池子统计', poolText, poolBank]);
  for (const [label, text, target] of jobs) {
    const r = await post(text, target);
    if (r.status >= 200 && r.status < 300) {
      console.log(`[distill] ${label}已写入 Hindsight：bank=${target} status=${r.status}`);
    } else {
      console.error(`[distill] ${label}写入失败：bank=${target} status=${r.status} ${r.body}`);
      process.exit(1);
    }
  }

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
