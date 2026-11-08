/**
 * 毫秒数转人类可读的时长。
 *
 * - < 1000ms：整数毫秒（`0ms`、`999ms`）
 * - < 60000ms：保留 1 位小数的秒（`1.0s`、`59.9s`）
 * - 其余：分钟 + 整数秒（`1m1s`、`1m30s`）
 *
 * @param {number} ms 毫秒数
 * @returns {string}
 */
export function formatMs(ms) {
  if (ms < 1000) return `${Math.trunc(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}
