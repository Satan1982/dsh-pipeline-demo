// ci/pass3/parse-labels.mjs —— 把逗号分隔的标签串解析成数组。
//
// 约定：按逗号切分，去掉每项首尾空白，丢掉空项，保序去重（先出现的保留）。
// 例：'a, b,,a' -> ['a', 'b']；'' -> []；' x , y , x ' -> ['x', 'y']。

/**
 * 解析逗号分隔的标签列表。
 * @param {string} [text] 原始标签串（可为空/未定义）
 * @returns {string[]} 去空白、去空项、保序去重后的标签
 */
export function parseLabelList(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text ?? '').split(',')) {
    const label = part.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}
