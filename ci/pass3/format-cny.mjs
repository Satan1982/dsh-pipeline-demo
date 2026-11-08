// 分转人民币字符串：0 -> '¥0.00'，1234 -> '¥12.34'，5 -> '¥0.05'。
//
// 只接受有限的非负数（单位：分）。NaN / Infinity / 负数说明调用方算错了金额，
// 必须当场抛 TypeError，而不是静默产出 '¥NaN' 或负数金额。
export function formatCny(cents) {
  if (!Number.isFinite(cents) || cents < 0) {
    throw new TypeError(`formatCny 需要有限的非负数（分），收到：${String(cents)}`);
  }
  return `¥${(cents / 100).toFixed(2)}`;
}
