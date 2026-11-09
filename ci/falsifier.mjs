/**
 * falsifier.mjs — P7.5 质疑者三判据（issue #237，来源 #229 对照表第 11 行）。
 *
 * 从 tools/pipeline/falsifier.mjs 移植「不需要跑模型」的三条机械判据：
 *   1) 断言增删 ↔ 基线数字一致性（删断言再同步基线会被抓到）；
 *   2) 新增导出符号在测试里的引用计数（0 引用 → warn）；
 *   3) 证据的 exit code / VERDICT 行 ↔ 实际输出一致性（防伪绿）。
 * 语义评审仍在 reviewWithPanel；这里只复算可数事实，判不了「断言写得对不对」。
 */

/** 与 scripts/verify.sh:104 完全同口径：`grep -o 'assert.' src/*.test.js ci/*.test.mjs`，按出现次数计。 */
export const ASSERT_RE = /assert\./g;
export const TEST_FILE_RE = /(?:^|\/)(?:[^/]+\.test\.[cm]?[jt]s|__tests__\/[^/]+|[^/]+\.spec\.[cm]?[jt]s)$/;

/** `scripts/test-baseline.txt`：`<tests> <asserts> <sha>`（首行）。 */
export function parseBaseline(text) {
  const line = String(text ?? '').split(/\r?\n/).find((l) => l.trim() !== '');
  if (!line) return null;
  const m = line.trim().split(/\s+/);
  const tests = Number(m[0]);
  const asserts = Number(m[1]);
  if (!Number.isFinite(tests) || !Number.isFinite(asserts)) return null;
  return { tests, asserts, sha: m[2] ?? '' };
}

/** 统计 diff 里测试文件的断言行增删。只认 `+++ b/<path>` 之后、且路径像测试文件的 hunk。 */
export function countAssertions(diffText) {
  let file = '';
  let inTest = false;
  let added = 0;
  let removed = 0;
  for (const raw of String(diffText ?? '').split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).trim().replace(/^b\//, '');
      inTest = TEST_FILE_RE.test(file);
      continue;
    }
    if (!inTest) continue;
    const count = (line) => (line.match(ASSERT_RE) ?? []).length;
    if (raw.startsWith('+') && !raw.startsWith('+++')) added += count(raw.slice(1));
    else if (raw.startsWith('-') && !raw.startsWith('---')) removed += count(raw.slice(1));
  }
  return { added, removed };
}

/** 新增的导出符号（function/class/const），用于检查「新符号有没有测试引用」。 */
export function findNewExports(diffText) {
  const out = [];
  const seen = new Set();
  let file = '';
  for (const raw of String(diffText ?? '').split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) { file = raw.slice(4).trim().replace(/^b\//, ''); continue; }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1);
    const m = /^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/.exec(line)
      ?? /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (!m) continue;
    const key = m[1] + '|' + file;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol: m[1], file });
  }
  return out;
}

/** 新增导出符号在测试源码里出现几次（按标识符边界计）。 */
export function countRefs(text, symbol) {
  const re = new RegExp('(?<![\\w$])' + symbol.replace(/[$]/g, '\\$') + '(?![\\w$])', 'g');
  return (String(text ?? '').match(re) ?? []).length;
}

/** 判据 1：基线断言数必须等于「base + diff 新增 - diff 删除」；测试数不许下降。 */
export function checkAssertDelta({ base, head, added = 0, removed = 0 } = {}) {
  if (!base || !head) return { rule: 'assert-delta', result: 'skip', detail: '缺少基线（scripts/test-baseline.txt 读不到）' };
  const expected = base.asserts + added - removed;
  if (head.tests < base.tests) {
    return {
      rule: 'assert-delta', result: 'fail',
      detail: `测试数下降：base ${base.tests} → head ${head.tests}（scripts/test-baseline.txt:1）`,
    };
  }
  if (head.asserts !== expected) {
    return {
      rule: 'assert-delta', result: 'fail',
      detail: `断言数与 diff 不一致：head ${head.asserts}，应为 ${expected}（base ${base.asserts} + 新增 ${added} - 删除 ${removed}）（scripts/test-baseline.txt:1）`,
    };
  }
  return { rule: 'assert-delta', result: 'pass', detail: `断言 ${base.asserts} → ${head.asserts}，新增 ${added} / 删除 ${removed} 与基线一致` };
}

/** 判据 2：新增导出符号 0 引用 → warn（不硬拦，符号可能由 CLI 或外部调用）。 */
export function checkSymbolBinding({ exports = [], testSource = '' } = {}) {
  if (!exports.length) return { rule: 'symbol-binding', result: 'pass', detail: '本次没有新增导出符号' };
  const unused = exports.filter((e) => countRefs(testSource, e.symbol) === 0);
  if (unused.length) {
    return {
      rule: 'symbol-binding', result: 'warn',
      detail: '新增导出符号未被任何测试引用：' + unused.map((u) => `${u.symbol}（${u.file}）`).join('、'),
    };
  }
  return { rule: 'symbol-binding', result: 'pass', detail: `新增导出符号 ${exports.length} 个，测试均有引用` };
}

/** 判据 3：声明 verdict 与实际 exit code / 输出末尾 VERDICT 行一致（防伪绿）。 */
export function checkEvidence({ declared = 'none', code = 0, out = '' } = {}) {
  const tail = String(out ?? '').trim().split(/\r?\n/).slice(-40).join('\n');
  const verdicts = [...tail.matchAll(/^VERDICT:\s*(PASS|FAIL|BLOCKED)\s*$/gm)].map((m) => m[1]);
  const last = verdicts.length ? verdicts[verdicts.length - 1] : '';
  if (declared === 'pass' && code !== 0) {
    return { rule: 'evidence', result: 'fail', detail: `声明 PASS，但实际 exit=${code}（伪绿）` };
  }
  if (declared === 'pass' && last && last !== 'PASS') {
    return { rule: 'evidence', result: 'fail', detail: `声明 PASS，但输出末尾是 VERDICT: ${last}` };
  }
  if (code === 0 && last === 'FAIL') {
    return { rule: 'evidence', result: 'fail', detail: 'exit=0 但输出末尾是 VERDICT: FAIL（结论与退出码矛盾）' };
  }
  return { rule: 'evidence', result: 'pass', detail: `exit=${code}，末尾 VERDICT=${last || '（无）'}，与声明一致` };
}

/** 汇总：fail → verdict fail；warn → warn；否则 pass。 */
export function summarize(checks = []) {
  if (checks.some((c) => c.result === 'fail')) return 'fail';
  if (checks.some((c) => c.result === 'warn')) return 'warn';
  return 'pass';
}
