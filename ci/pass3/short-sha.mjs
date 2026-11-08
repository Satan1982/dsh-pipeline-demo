// 短哈希：取 sha 的前 len 位；输入不足 len 位时原样返回，空串返回空串。
export function shortSha(sha, len = 7) {
  return sha.slice(0, len);
}
