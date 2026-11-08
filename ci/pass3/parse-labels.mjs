/**
 * parse-labels.mjs — 把逗号分隔的标签文本解析成标签列表。
 *
 * 规则：按逗号切分，去掉每项首尾空白与空项，按首次出现顺序去重。
 * 空输入（'' / 只有空白 / 只有逗号）返回空数组。
 *
 * @param {string} text 逗号分隔的标签文本
 * @returns {string[]} 去空去重后的标签列表（保持原顺序）
 */
export function parseLabelList(text) {
  const seen = new Set();
  const labels = [];
  for (const part of String(text ?? '').split(',')) {
    const label = part.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}
