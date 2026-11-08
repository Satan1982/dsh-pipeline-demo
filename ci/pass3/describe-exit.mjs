// 把 run.mjs 的退出码翻成稳定短句。
//
// 退出码是流水线各步骤之间的契约：0 表示全过，2..6 表示不同阶段的失败。
// 这里只做纯映射，未知码统一回 'unknown'（不抛错），调用方无需再兜一层 try/catch。
const LABELS = new Map([
  [0, 'ok'],
  [2, 'invalid-spec'],
  [3, 'verify-failed'],
  [4, 'worker-failed'],
  [5, 'timeout'],
  [6, 'rejected'],
]);

export function describeExit(code) {
  return LABELS.get(code) ?? 'unknown';
}
