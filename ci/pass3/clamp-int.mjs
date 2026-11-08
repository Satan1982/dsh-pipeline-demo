// ci/pass3/clamp-int.mjs — 整数夹取。
//
// 先把 x 按 Math.trunc 向零取整，再夹到闭区间 [min, max]。
// 非有限数（NaN / ±Infinity）或非数字无法得到稳定的整数结果，统一抛 TypeError。

function requireFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`clampInt 需要有限的 ${name}，收到 ${String(value)}`);
  }
}

/**
 * @param {number} x 待夹取的数
 * @param {number} min 下界（含）
 * @param {number} max 上界（含）
 * @returns {number} Math.trunc(x) 夹到 [min, max] 后的值
 */
export function clampInt(x, min, max) {
  requireFinite('x', x);
  requireFinite('min', min);
  requireFinite('max', max);

  const truncated = Math.trunc(x);
  return Math.min(Math.max(truncated, min), max);
}
