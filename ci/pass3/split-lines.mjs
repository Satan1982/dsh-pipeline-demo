/**
 * 按换行切分文本，丢掉纯空白行；其余行原样保留（不 trim）。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitNonEmptyLines(text) {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}
