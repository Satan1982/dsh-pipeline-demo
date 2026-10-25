// 验收命令的「显式裁决」。
//
// 三层依据（docs/research/SUMMARY.md §四 P0-1）：
// - products.md:159  Junie `/demo`：a completed agent process does not tell you whether a check passed
// - top-repos.md:17  让进程退出码说话，别让 agent 自述
// - vibe-coding-cn.md:82  验收表逐项标 通过/未通过/未验证；测试通过 ≠ 安全
//
// 于是：退出码 0 只是「命令没崩」，不等于「验收过了」。验收命令若打印裁决行
//   VERDICT: PASS
//   VERDICT: FAIL <原因>
// 就只认它；没打印则按退出码放行，但记一条 warn（老工单向后兼容）。
// 想要硬的，在 issue 上打 `verdict:strict` 标签 —— 那时缺裁决行直接算失败。

const VERDICT_LINE = /^\s*VERDICT:\s*(PASS|FAIL)\b[ \t]*(.*)$/gim;

/**
 * @param {string} output 验收命令的标准输出 + 标准错误
 * @returns {{verdict: 'pass'|'fail'|'unknown', reason: string}}
 */
export function parseVerdict(output) {
  const text = String(output ?? '');
  let last = null;
  for (const m of text.matchAll(VERDICT_LINE)) {
    last = { verdict: m[1].toLowerCase(), reason: (m[2] || '').trim() };
  }
  // 一条裁决都没有：unknown，由调用方决定是放行（记录 warn）还是拦下（strict）。
  if (!last) return { verdict: 'unknown', reason: '' };
  return last;
}

/**
 * 把退出码与裁决行合成一个结论。
 * @param {{code: number, out?: string, err?: string}} res
 * @param {{strict?: boolean}} [opts]
 * @returns {{ok: boolean, verdict: 'pass'|'fail'|'unknown', detail: string}}
 */
export function decideAcceptance(res, opts = {}) {
  const parsed = parseVerdict(`${res?.out ?? ''}\n${res?.err ?? ''}`);
  if (parsed.verdict === 'fail') {
    return { ok: false, verdict: 'fail', detail: `验收裁决为 FAIL${parsed.reason ? `：${parsed.reason}` : ''}（命令 exit=${res?.code}）` };
  }
  if (parsed.verdict === 'pass') {
    // 裁决说 PASS 但命令本身崩了，仍按失败处理：裁决不能盖过进程退出码。
    if (res?.code !== 0) return { ok: false, verdict: 'fail', detail: `验收命令自己 exit=${res?.code}，即使打印了 VERDICT: PASS 也不算通过` };
    return { ok: true, verdict: 'pass', detail: '验收裁决 PASS' };
  }
  if (opts.strict) return { ok: false, verdict: 'unknown', detail: '验收命令没有打印 VERDICT 行（本工单要求 verdict:strict）' };
  if (res?.code !== 0) return { ok: false, verdict: 'unknown', detail: `验收命令 exit=${res?.code}` };
  return { ok: true, verdict: 'unknown', detail: '验收命令 exit=0 但没有 VERDICT 行（按退出码放行）' };
}
