// 短哈希：日志与 CI 输出里常用的哈希缩写（默认取 Git 的 7 位）。
// 长度不足 len 时原样返回；空串返回空串（不补位、不抛错）。
export function shortSha(sha, len = 7) {
  if (typeof sha !== 'string') {
    throw new TypeError('shortSha expects a string');
  }
  return sha.slice(0, len);
}
