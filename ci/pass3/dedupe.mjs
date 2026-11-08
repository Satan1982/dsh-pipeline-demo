// ci/pass3/dedupe.mjs —— 保序去重（Pass^3 切片）。
//
// 判重语义是 SameValueZero：NaN 与 NaN 视为同一个值，+0 与 -0 视为同一个值。
// Set 的相等判断正是 SameValueZero，因此借助 Set 去重、按首次出现顺序展开成
// 新数组即可；入参只被迭代，不会被修改。

/**
 * 按 SameValueZero 保序去重。
 *
 * @template T
 * @param {Iterable<T>} items 待去重序列
 * @returns {T[]} 去重后的新数组
 */
export function dedupe(items) {
  return [...new Set(items)];
}
