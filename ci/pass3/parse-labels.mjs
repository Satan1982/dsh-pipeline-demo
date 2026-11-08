// parse-labels.mjs — 逗号分隔标签列表的解析（issue #175）。
//
// 规则：按逗号切分，去掉每项首尾空白与空项，再按首次出现顺序去重。
// 例：'a, b,,a' -> ['a', 'b']；'' -> []。

/**
 * @param {string} text 逗号分隔的标签列表
 * @returns {string[]} 去空白、去空项、保序去重后的标签
 */
export function parseLabelList(text) {
  const seen = new Set();
  const labels = [];
  for (const part of text.split(',')) {
    const label = part.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}
