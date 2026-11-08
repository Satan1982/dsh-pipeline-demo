// issue #215：敏感文本脱敏——只保留前 6 位，其余一律用省略号代替。
//
// 规则（见验收标准）：
// - 长度 > 6：返回前 6 位 + '…'
// - 长度 <= 6：整段都算敏感，返回 '…'
// - 非字符串：无法确定长度，返回 '…'
export function maskSecret(text) {
  if (typeof text !== 'string' || text.length <= 6) return '…';
  return `${text.slice(0, 6)}…`;
}
