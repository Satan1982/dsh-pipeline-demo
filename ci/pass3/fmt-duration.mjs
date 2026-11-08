// 毫秒 → 紧凑时长：<1s 用整数毫秒，<1min 用 1 位小数秒，否则用 分+秒。
// 例：0 → 0ms，999 → 999ms，1000 → 1.0s，61000 → 1m1s，90000 → 1m30s。

export function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`formatMs 需要非负有限数值（收到 ${ms}）`);
  }

  if (ms < 1000) {
    return `${Math.trunc(ms)}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}