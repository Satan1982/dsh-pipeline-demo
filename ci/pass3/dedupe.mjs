// 保序去重：保留每个值第一次出现的位置，按 SameValueZero 判等。
// Set 的键判等规则就是 SameValueZero（NaN 等于 NaN，+0 等于 -0），
// 展开成数组即得到新数组，入参不会被修改。

/**
 * @template T
 * @param {Iterable<T>} items
 * @returns {T[]} 去重后的新数组，顺序与首次出现顺序一致
 */
export function dedupe(items) {
  return [...new Set(items)];
}
