// 脱敏：只保留前 6 位，其余用省略号代替；长度不足或非字符串时不泄露任何内容。
export function maskSecret(text) {
  if (typeof text !== 'string' || text.length <= 6) {
    return '…';
  }
  return `${text.slice(0, 6)}…`;
}
