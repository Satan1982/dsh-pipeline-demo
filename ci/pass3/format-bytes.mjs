// 字节数格式化：B / KiB / MiB（1024 进制）。
export function formatBytes(n) {
  if (n < 1024) return `${Math.trunc(n)} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1048576).toFixed(1)} MiB`;
}
