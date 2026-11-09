#!/usr/bin/env node
// ci/mutate.mjs —— P4.5 变异探针（docs/88 门禁对照表 #5 / issue #235）。
//
// 为什么需要：现有门禁只回答「测试跑绿」。恒真断言（assert.equal(true, true)）、
// 只覆盖 happy path 的测试都能过 —— 测试从未被证明「真能失败」。run.mjs 的 P4.5
// 用变异探针回答这个问题：把源码的判据改坏一格，测试还绿就说明它没在看着。
//
// 判据（移植自 D:\code\tools\pipeline\run.mjs P4.5）：
//   1) 只变异 base...HEAD 的**新增行**；测试文件不进探针（自己改自己不算）。
//   2) 每片 mutants >= 1 且 survivors = 0。
//   3) 新增行无可注入变异 -> 默认记 warn；只有打了 mutation:strict 的工单才 BLOCKED(exit 3)。
//
// 成本取舍（本模块最重要的一个决定）：变异测试要把测试跑 N 遍，而一条工单的新增行
// 常有几十行。所以默认路径**只扫描**（0 次测试运行），把「有没有可变异的新增行」变成
// 一条廉价的旁证；只有 mutation:strict 才真的逐变异体跑受影响测试。理由见 issue #235
// 建议方案第 3 条：入口改动常是文档/配置，默认 BLOCKED 会大面积误伤。
//
// 超时/崩溃的变异体按「未存活」记，但必须写明原因（编译型变异本模块不覆盖）——
// 不能把它悄悄计成一条白捡的 killed。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NL = String.fromCharCode(10);
const BT = String.fromCharCode(96); // 反引号：模板字符串不参与文本变异

// 与 ci/review.mjs 同一口径：测试文件自己在 src/ 与 ci/ 下。
export const TEST_FILE_RE = /^(?:src|ci)\/.*\.test\.(?:js|mjs)$/;

// 只变异代码文件；文档/配置/基线不进探针。
export const CODE_FILE_RE = /\.(?:mjs|cjs|js|ts)$/;

// 算子表：按顺序取**第一个**命中的算子，一行只产一个变异体（确定性优先）。
export const OPERATORS = [
  { id: 'and-to-or', find: /&&/, to: '||', why: '&& 翻成 ||：短路条件被抹掉时测试必须发现' },
  { id: 'or-to-and', find: /\|\|/, to: '&&', why: '|| 翻成 &&：兜底分支被抹掉时测试必须发现' },
  { id: 'ge-to-gt', find: />=/, to: '>', why: '>= 翻成 >：边界偏一格' },
  { id: 'le-to-lt', find: /<=/, to: '<', why: '<= 翻成 <：边界偏一格' },
  { id: 'eq-to-ne', find: /===/, to: '!==', why: '=== 翻成 !==：相等判断反转' },
  { id: 'ne-to-eq', find: /!==/, to: '===', why: '!== 翻成 ===：不等判断反转' },
  { id: 'true-to-false', find: /return\s+true\b/, to: 'return false', why: 'return true 翻成 false' },
  { id: 'false-to-true', find: /return\s+false\b/, to: 'return true', why: 'return false 翻成 true' },
  { id: 'zero-to-one', find: /(?<![\w.$])0(?![\w.])/, to: '1', why: '常量 0 翻成 1：边界 off-by-one' },
  { id: 'one-to-zero', find: /(?<![\w.$])1(?![\w.])/, to: '0', why: '常量 1 翻成 0：边界 off-by-one' },
];

// 这些行不产变异体：注释、import、模板字符串（文本层定位不可靠）。
const SKIP_RULES = [
  { re: /^\s*$/, why: '空行' },
  { re: /^\s*(\/\/|\/\*|\*)/, why: '注释行' },
  { re: /^\s*import\b/, why: 'import 声明' },
  { re: /^\s*export\s+\{[^}]*\}\s*from\b/, why: '再导出声明' },
  { re: new RegExp(BT), why: '含模板字符串，文本变异定位不可靠' },
];

/**
 * 从一个 unified diff 里取出「新增行」，并带上新文件里的行号。
 * @param {string} patch 整个 diff（可含多个文件；-U0 与 -U3 都能解析）
 * @returns {Array<{file: string, line: number, text: string}>}
 */
export function parseAddedLines(patch) {
  const out = [];
  let file = null;
  let newLine = 0;
  for (const raw of String(patch ?? '').split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) { file = null; continue; }
    if (raw.startsWith('+++ ')) {
      // '+++ b/ci/foo.mjs'；'+++ /dev/null' 表示删除，没有新增行可变异。
      file = raw.startsWith('+++ b/') ? raw.slice(6).trim() : null;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { newLine = Number(h[1]); continue; }
    if (!file) continue;
    if (raw.startsWith('+')) { out.push({ file, line: newLine, text: raw.slice(1) }); newLine += 1; continue; }
    if (raw.startsWith('-')) continue;
    if (raw.startsWith(' ')) { newLine += 1; continue; }
    // '\ No newline at end of file' 等元数据行：不影响行号推进
  }
  return out;
}

/** 这一行能不能变异；能则回一个变异体，不能则回 { skip: 原因 }。 */
export function mutateLine(line) {
  for (const rule of SKIP_RULES) {
    if (rule.re.test(line)) return { skip: rule.why };
  }
  for (const op of OPERATORS) {
    const m = op.find.exec(line);
    if (!m) continue;
    return {
      op: op.id,
      why: op.why,
      before: line,
      after: line.slice(0, m.index) + op.to + line.slice(m.index + m[0].length),
    };
  }
  return { skip: '没有可注入的变异算子' };
}

/**
 * 计划：把 diff 变成一张变异体清单（不跑任何测试）。
 * @param {{patch?: string, files?: Array<{filename: string, patch: string}>}} diff
 */
export function planMutations(diff = {}) {
  const files = Array.isArray(diff.files)
    ? diff.files.map((f) => ({ filename: f.filename, patch: f.patch ?? '' }))
    : [{ filename: null, patch: diff.patch ?? '' }];
  const added = [];
  for (const f of files) {
    for (const a of parseAddedLines(f.patch)) added.push({ ...a, file: a.file ?? f.filename });
  }

  const mutants = [];
  const skipped = [];
  for (const a of added) {
    if (TEST_FILE_RE.test(a.file)) { skipped.push({ ...a, why: '测试文件不进探针（自己改自己不算）' }); continue; }
    if (!CODE_FILE_RE.test(a.file)) { skipped.push({ ...a, why: '非代码文件' }); continue; }
    const r = mutateLine(a.text);
    if (r.skip) { skipped.push({ ...a, why: r.skip }); continue; }
    mutants.push({ file: a.file, line: a.line, op: r.op, why: r.why, before: r.before, after: r.after });
  }
  return { added: added.length, mutants, skipped };
}

/** 变异体对应的受影响测试文件（只处理同目录同名 .test 的约定）。 */
export function testPathFor(file) {
  const m = /^(.*)\.(?:mjs|cjs|js|ts)$/.exec(file ?? '');
  return m ? m[1] + '.test.mjs' : null;
}

/** 把变异体写进源码文本；行内容漂移（diff 与工作树不一致）时拒绝改。 */
export function applyMutant(source, mutant) {
  const lines = String(source ?? '').split(/\r?\n/);
  const i = mutant.line - 1;
  if (i < 0 || i >= lines.length) return { ok: false, why: '行号越界：' + mutant.line };
  if (lines[i] !== mutant.before) {
    return { ok: false, why: '第 ' + mutant.line + ' 行内容与 diff 不一致（当前：' + lines[i].slice(0, 80) + '）' };
  }
  lines[i] = mutant.after;
  return { ok: true, text: lines.join(NL) };
}

/**
 * 逐个变异体：写进工作树 -> 跑受影响测试 -> 无论结果都还原。
 * runTests(mutant) 返回 { code, timedOut?, missingTest? }，由调用方决定怎么跑。
 */
export async function probeMutations({ root, mutants, runTests, limit = 40 }) {
  const results = [];
  for (const mutant of mutants.slice(0, limit)) {
    const abs = path.join(root, mutant.file);
    if (!existsSync(abs)) { results.push({ mutant, status: 'skipped', why: '文件不存在' }); continue; }
    const original = readFileSync(abs, 'utf8');
    const applied = applyMutant(original, mutant);
    if (!applied.ok) { results.push({ mutant, status: 'skipped', why: applied.why }); continue; }
    let r = {};
    try {
      writeFileSync(abs, applied.text);
      r = (await runTests(mutant)) ?? {};
    } finally {
      writeFileSync(abs, original);
    }
    if (r.missingTest) {
      results.push({ mutant, status: 'survived', why: '该文件没有对应测试，变异体不可能被杀死' });
    } else if (r.timedOut) {
      results.push({ mutant, status: 'killed', why: '变异体把测试卡死/超时（按未存活记，原因在此）' });
    } else if (r.code === 0) {
      results.push({ mutant, status: 'survived', why: '测试仍全绿：这条判据没有被任何测试看着' });
    } else {
      results.push({ mutant, status: 'killed', code: r.code, why: '测试变红（变异体被发现）' });
    }
  }
  return results;
}

/**
 * 判据合成。strict 来自 issue 的 mutation:strict 标签。
 * 返回 code 为进程退出码：0 通过/warn，3 BLOCKED（与 run.mjs 的 BLOCKED 口径一致）。
 */
export function summarize({ plan, results = [], strict = false, limit = 40 }) {
  const mutants = plan?.mutants?.length ?? 0;
  const killed = results.filter((r) => r.status === 'killed').length;
  const survived = results.filter((r) => r.status === 'survived').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  if (mutants === 0) {
    const lines = (plan?.skipped ?? []).map((s) => '  - ' + s.file + ':' + s.line + ' ' + s.why);
    return {
      ok: !strict,
      blocked: strict,
      code: strict ? 3 : 0,
      mutants: 0, killed: 0, survived: 0, skipped: 0,
      verdict: strict ? 'BLOCKED' : 'WARN',
      text: strict
        ? '新增行没有可注入的变异（新增行无可变异 -> BLOCKED，mutation:strict）'
        : '新增行没有可注入的变异（warn：入口改动常是文档/配置，不挡任务）',
      lines,
    };
  }
  const survivors = results.filter((r) => r.status === 'survived');
  const overLimit = mutants > limit;
  const blocked = strict && survivors.length > 0;
  return {
    ok: !blocked,
    blocked,
    code: blocked ? 3 : 0,
    mutants, killed, survived, skipped, limit, overLimit,
    verdict: blocked ? 'BLOCKED' : 'PASS',
    text: '变异体 ' + mutants + ' 个（跑 ' + Math.min(mutants, limit) + '）：killed=' + killed + ' survived=' + survived + ' skipped=' + skipped
      + (overLimit ? '（超过上限 ' + limit + '，其余未跑）' : '')
      + (blocked ? ' -> BLOCKED：有判据没被测试看着' : ''),
    lines: survivors.map((s) => '  - SURVIVED ' + s.mutant.file + ':' + s.mutant.line + ' ' + s.mutant.op + ' — ' + s.mutant.why),
  };
}

/**
 * 调度链入口（dispatch 只调这一个函数）：给定 worktree 与 base...HEAD 的 patch，
 * 返回 summarize 口径的判定。strict=false 只扫描、不跑测试（成本 0 次测试运行）；
 * strict=true 时逐变异体跑受影响测试，存活即 BLOCKED。
 */
export async function probeWorktree({ root, patch, strict = false, limit = 40, runTests }) {
  const plan = planMutations({ patch });
  const results = strict && plan.mutants.length
    ? await probeMutations({ root, mutants: plan.mutants, limit, runTests })
    : [];
  return { ...summarize({ plan, results, strict, limit }), plan };
}

// ---- CLI（人工/事后复算用；调度链里走 dispatch 的接线） ----
if (path.basename(String(process.argv[1] ?? '')) === 'mutate.mjs') {
  const { execFileSync } = await import('node:child_process');
  const GIT = process.env.DSH_GIT || 'C:/Program Files/Git/cmd/git.exe';
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const strict = args.includes('--strict');
  const base = opt('--base', 'origin/main');
  const head = opt('--head', 'HEAD');
  const root = opt('--root', process.cwd());
  const limit = Number(opt('--limit', '40'));
  try {
    const patch = execFileSync(GIT, ['diff', '--unified=0', base + '...' + head], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const plan = planMutations({ patch });
    let results = [];
    if (strict && plan.mutants.length) {
      results = await probeMutations({
        root, mutants: plan.mutants, limit,
        runTests: (mutant) => {
          const tf = testPathFor(mutant.file);
          const abs = tf ? path.join(root, tf) : null;
          if (!abs || !existsSync(abs)) return { missingTest: true };
          try {
            execFileSync(process.execPath, ['--test', abs], { cwd: root, stdio: 'pipe', timeout: 120000 });
            return { code: 0 };
          } catch (e) {
            return { code: typeof e.status === 'number' ? e.status : 1, timedOut: e.killed === true };
          }
        },
      });
    }
    const sum = summarize({ plan, results, strict, limit });
    console.log('[mutate] 新增行 ' + plan.added + '，变异体 ' + plan.mutants.length + '，跳过 ' + plan.skipped.length);
    for (const l of sum.lines.slice(0, 40)) console.log(l);
    console.log(sum.verdict + ': ' + sum.text);
    process.exit(sum.code);
  } catch (e) {
    console.error('[mutate] 失败：' + e.message);
    process.exit(1);
  }
}
