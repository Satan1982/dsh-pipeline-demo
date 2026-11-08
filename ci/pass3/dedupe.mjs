/**
 * dedupe — 按 SameValueZero 语义保序去重。
 *
 * SameValueZero 与 `Set` 的相等判定一致：`NaN` 等于自身，`+0` 与 `-0` 视为相等。
 * Set 的迭代顺序就是插入顺序，所以第一次出现的元素保留原位置，重复项被丢弃。
 *
 * @param {Iterable<unknown>} items 待去重的元素集合，不会被修改
 * @returns {Array<unknown>} 去重后的新数组
 */
export function dedupe(items) {
  return [...new Set(items)];
}
