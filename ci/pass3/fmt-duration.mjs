/**
 * formatMs — 把毫秒数格式化成紧凑的时长文本。
 *
 * 规则：
 *   - < 1000ms：整数 + 'ms'（如 0 → '0ms'，999 → '999ms'）
 *   - < 60000ms：秒保留 1 位小数 + 's'（如 1000 → '1.0s'）
 *   - 其余：分 + 'm' + 整数秒 + 's'（如 61000 → '1m1s'，90000 → '1m30s'）
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

export function formatMs(ms) {
  if (ms < MS_PER_SECOND) return `${Math.trunc(ms)}ms`;
  if (ms < MS_PER_MINUTE) return `${(ms / MS_PER_SECOND).toFixed(1)}s`;

  const minutes = Math.floor(ms / MS_PER_MINUTE);
  const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
  return `${minutes}m${seconds}s`;
}
