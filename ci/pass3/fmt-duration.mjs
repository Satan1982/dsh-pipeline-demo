// 毫秒 -> 人读时长（Pass^3 报告里的耗时列）。
//
// 规则（issue #130）：
//   < 1000ms       -> 整数 + 'ms'        （0 -> '0ms'，999 -> '999ms'）
//   < 60000ms      -> 秒 + 1 位小数 + 's'（1000 -> '1.0s'）
//   其余           -> 分 + 'm' + 整数秒 + 's'（61000 -> '1m1s'，90000 -> '1m30s'）
export function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new TypeError(`formatMs 需要非负有限数：${ms}`);
  }
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
}
