// 整数夹取：先把 x 按 Math.trunc 取整，再夹到 [min, max]。
//
// 语义要点：
// - 先取整再夹取，所以 2.9 落在 [0,3] 里得到 2（而不是先被夹成 3 再取整）；
// - x / min / max 任一是非有限数（Infinity、-Infinity、NaN、非 number）都抛 TypeError，
//   不让 Infinity 被静默夹成边界值。

/**
 * @param {number} x 待取整并夹取的数
 * @param {number} min 下界（含）
 * @param {number} max 上界（含）
 * @returns {number} 取整后夹在 [min, max] 内的整数
 */
export function clampInt(x, min, max) {
  if (!Number.isFinite(x)) throw new TypeError(`clampInt: x 必须是有限数，收到 ${String(x)}`);
  if (!Number.isFinite(min)) throw new TypeError(`clampInt: min 必须是有限数，收到 ${String(min)}`);
  if (!Number.isFinite(max)) throw new TypeError(`clampInt: max 必须是有限数，收到 ${String(max)}`);
  return Math.min(Math.max(Math.trunc(x), min), max);
}
