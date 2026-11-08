/**
 * short-sha.mjs — 短哈希
 *
 * 哈希在日志/分支名里常常只需要前缀；这里按字符数截断，
 * 长度不足 len 时保持原样（短哈希不该被补零或抛错）。
 */

export function shortSha(sha, len = 7) {
  return String(sha ?? '').slice(0, len);
}
