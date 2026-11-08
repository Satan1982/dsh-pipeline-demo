// 日志脱敏：密文只保留前 6 位，其余一律用省略号代替。
// 长度不超过 6 位（含空串）或不是字符串时，连前缀也不泄露。

export function maskSecret(text) {
  if (typeof text !== 'string' || text.length <= 6) return '…';
  return `${text.slice(0, 6)}…`;
}
