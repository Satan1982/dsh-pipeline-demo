// 分转人民币字符串。
// 例如 formatCny(0) === '¥0.00'，formatCny(1234) === '¥12.34'。
export function formatCny(cents) {
  if (!Number.isFinite(cents) || cents < 0) {
    throw new TypeError('cents must be a finite, non-negative number');
  }
  return `¥${(cents / 100).toFixed(2)}`;
}
