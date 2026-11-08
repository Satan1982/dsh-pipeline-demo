/**
 * Format a duration in milliseconds as a compact human-readable string.
 *
 * Rules:
 * - < 1000ms  -> integer milliseconds, e.g. "0ms", "999ms"
 * - < 60000ms -> seconds with one decimal, e.g. "1.0s", "59.9s"
 * - otherwise -> whole minutes + whole seconds, e.g. "1m1s", "1m30s"
 *
 * @param {number} ms duration in milliseconds
 * @returns {string}
 */
export function formatMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds}s`;
}
