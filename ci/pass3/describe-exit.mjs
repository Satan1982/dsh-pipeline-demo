// run.mjs 退出码 -> 人读短句。
//
// 退出码是 Pass^3 runner 唯一的机械结论，但日志和 PR 里
// 直接看 2/3/4/5/6 不直观。这里只做纯映射，不读环境、不抛错：
// 未知码（包括被信号杀掉时的 128+N、core dump 等）一律 'unknown'，
// 免得把「没归类」误报成某个已知失败类型。

const EXIT_LABELS = new Map([
  [0, 'ok'],
  [2, 'invalid-spec'],
  [3, 'verify-failed'],
  [4, 'worker-failed'],
  [5, 'timeout'],
  [6, 'rejected'],
]);

/**
 * @param {number} code 进程退出码
 * @returns {'ok'|'invalid-spec'|'verify-failed'|'worker-failed'|'timeout'|'rejected'|'unknown'}
 */
export function describeExit(code) {
  return EXIT_LABELS.get(code) ?? 'unknown';
}
