// 字节数格式化：B / KiB / MiB（1024 进制）。

/**
 * 把字节数格式化为带单位的可读字符串。
 * - < 1024：整数 + ' B'
 * - < 1024 * 1024：(n / 1024).toFixed(1) + ' KiB'
 * - 其余：(n / (1024 * 1024)).toFixed(1) + ' MiB'
 *
 * @param {number} n 字节数
 * @returns {string}
 */
export function formatBytes(n) {
  if (n < 1024) return `${Math.floor(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
