// 分转人民币字符串：整数分值 → '¥' + 元，保留两位小数。
//
// 只接受有限且非负的数值；非有限数（NaN/Infinity）或负数抛 TypeError。
// 例如 0 → '¥0.00'，1234 → '¥12.34'，5 → '¥0.05'。

/**
 * @param {number} cents 分值
 * @returns {string} 人民币金额字符串，形如 '¥12.34'
 */
export function formatCny(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) {
    throw new TypeError(`formatCny: cents 必须是有限数，收到 ${String(cents)}`);
  }
  if (cents < 0) {
    throw new TypeError(`formatCny: cents 不能为负，收到 ${cents}`);
  }
  return `¥${(cents / 100).toFixed(2)}`;
}
