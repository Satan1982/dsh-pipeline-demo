// 把字节数格式化成人类可读的 B/KiB/MiB。
const KiB = 1024;
const MiB = 1024 * 1024;

export function formatBytes(n) {
  if (n < KiB) return `${Math.round(n)} B`;
  if (n < MiB) return `${(n / KiB).toFixed(1)} KiB`;
  return `${(n / MiB).toFixed(1)} MiB`;
}
