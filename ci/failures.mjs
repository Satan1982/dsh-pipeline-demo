/**
 * failures.mjs — 失败指纹库
 *
 * 为什么需要: 调度器把失败回灌给「同一张工单的下一次尝试」，但换个工单、同一类错误
 * 还会从零摸索一遍。这里把每次失败归一化成稳定指纹，落进仓库里的 JSONL：
 *   - 下次遇到同指纹，直接把上次的根因与修法喂给 agent；
 *   - 指纹变化本身就是信号（同一张工单反复失败但指纹不同 = 在瞎试）。
 *
 * 存储格式（追加写，不重写）：每行一个 JSON
 *   {"fp":"a1b2c3d4e5f60718","sig":"首行...","issue":25,"attempt":1,
 *    "reason":"...","fix":"...","at":"2026-10-25T01:00:00.000Z"}
 *
 * 用 append-only 是为了可审计：改了判定逻辑也不会丢掉历史。
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_STORE = 'docs/failures.jsonl';

// 把错误文本归一化成「症状骨架」：抹掉每次都变的东西，留下真正决定性的部分。
// 注意必须逐行处理——整体 replace(/\s+/g) 会把换行也吞掉，签名就退化成一行。
export function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line
      .replace(/\b[0-9a-f]{7,40}\b/g, '<hex>')                    // 提交 sha、run id 里的长 hex
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')            // ISO 时间
      .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds)\b/g, '<dur>')
      .replace(/\b\d+\s*(?:分钟|秒)\b/g, '<dur>')
      .replace(/[A-Za-z]:[\\/][^\s:]+/g, '<path>')                // Windows 绝对路径
      .replace(/\/(?:tmp|home|Users)\/[^\s:]+/g, '<path>')        // POSIX 绝对路径
      .replace(/\bissue #\d+\b/g, 'issue #<n>')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

// 指纹只看「症状骨架」：错误种类 + 命中规则名，忽略栈帧与每次不同的尾巴。
// 早期版本取前 6 行，结果同一个「独立门禁未通过」因为尾部 verify 输出不同被拆成 6 个指纹，
// 记忆库等于失效——2026-10-25 改成「首行 + 规则集合」。
export function signature(text) {
  const norm = normalize(text);
  const lines = norm
    .split('\n')
    .map((l) => l.replace(/^Error: /, ''))
    .filter((l) => !/^at\s/.test(l) && !/^node:internal/.test(l) && !/^<path>/.test(l));

  // 首行经常是「exit code 1」「Error」这种没有信息量的壳子；遇到它要往下找到
  // 第一行真正的症状，否则所有 exit=1 的失败会被并成同一个指纹。
  const GENERIC = /^(?:exit(?:=|\scode)?\s*\d+|error|failed|失败)$/i;
  const normed = lines.map((l) => l.replace(/\bexit=\d+\b/g, 'exit=*'));
  const head = (normed.find((l) => !GENERIC.test(l.trim())) ?? normed[0] ?? '').slice(0, 200);

  // 评审层与门禁的判定都写在 [rule] 里，抽出来当下半段：同类根因必同指纹，
  // 不同规则（baseline-unsynced vs debug-residue）仍是不同指纹。
  const rules = [...new Set([...norm.matchAll(/\[([a-z][a-z0-9-]*)\]/g)].map((m) => m[1]))].sort();

  return rules.length ? `${head} | rules=${rules.join(',')}` : head;
}

export function fingerprint(text) {
  return createHash('sha256').update(signature(text)).digest('hex').slice(0, 16);
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

// 追加写是事实，读取时按 fp 折叠成「汇总视图」。
export function loadStore(file = DEFAULT_STORE) {
  const byFp = new Map();
  for (const rec of readLines(file)) {
    const cur = byFp.get(rec.fp);
    if (!cur) {
      byFp.set(rec.fp, { ...rec, count: 1, issues: [rec.issue] });
      continue;
    }
    cur.count += 1;
    if (!cur.issues.includes(rec.issue)) cur.issues.push(rec.issue);
    cur.lastAt = rec.at;
    if (rec.fix) cur.fix = rec.fix;       // 后写的修法覆盖先写的
    if (rec.reason) cur.reason = rec.reason;
  }
  return byFp;
}

export function lookup(textOrFp, file = DEFAULT_STORE) {
  const fp = /^[0-9a-f]{16}$/.test(textOrFp) ? textOrFp : fingerprint(textOrFp);
  return loadStore(file).get(fp) ?? null;
}

export function recordFailure({ text, issue, attempt = 1, reason, fix }, file = DEFAULT_STORE) {
  const rec = {
    fp: fingerprint(text ?? reason ?? ''),
    sig: signature(text ?? reason ?? ''),
    issue,
    attempt,
    reason: String(reason ?? text ?? '').slice(0, 2000),
    fix: fix ? String(fix).slice(0, 2000) : null,
    at: new Date().toISOString(),
  };
  const dir = path.dirname(file);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`);
  return rec;
}

// 这段文本会插进 agent 的 prompt：告诉它「这件事以前发生过，根因和修法如下」。
export function formatPriorFailures(text, file = DEFAULT_STORE, limit = 2) {
  const store = loadStore(file);
  if (store.size === 0) return '';
  const fp = fingerprint(text);
  const exact = store.get(fp);
  // 优先给同指纹记录；没有则在整库里找最近同 issue 的历史（帮助跨工单复用）
  const picks = exact ? [exact] : [];
  if (picks.length === 0) return '';
  return picks.slice(0, limit).map((r) => [
    `### 同一个根因出现过 ${r.count} 次（指纹 ${r.fp}，最近一次 issue #${r.issues.at(-1)}）`,
    r.reason ? `上次现象：${r.reason.split('\n').slice(0, 6).join('\n')}` : '',
    r.fix ? `上次修法：${r.fix}` : '上次没有记录修法——这次务必把根因写进提交说明。',
  ].filter(Boolean).join('\n')).join('\n\n');
}

/**
 * 判定逻辑改过之后，旧记录的 fp 是旧算法算的，命中会失败。repair 用当前算法重算并回写。
 * 追加写的账本可能留下同一 (fp, issue, attempt) 的重复行，这里一并去重。
 */
export function repairStore(file = DEFAULT_STORE) {
  const lines = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const seen = new Map();
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const text = rec.reason ?? rec.sig ?? '';
    const key = `${fingerprint(text)}|${rec.issue}|${rec.attempt}`;
    if (!seen.has(key)) seen.set(key, { ...rec, fp: fingerprint(text), sig: signature(text) });
  }
  const out = [...seen.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  writeFileSync(file, `${out.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { before: lines.length, after: out.length, fps: new Set(out.map((r) => r.fp)).size };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const [cmd = 'show', file = DEFAULT_STORE] = process.argv.slice(2);
  if (cmd === 'repair') {
    console.log(JSON.stringify(repairStore(file)));
  } else {
    const store = loadStore(file);
    const rows = [...store.values()].sort((a, b) => b.count - a.count);
    console.log(`records=${store.size} fps=${rows.length}`);
    for (const r of rows) console.log(`  ${r.fp} x${r.count} issues=${r.issues.join(',')}`);
  }
}
