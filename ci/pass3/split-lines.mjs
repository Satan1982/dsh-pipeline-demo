/**
 * 按换行切分文本，丢弃纯空白行，其余行原样保留（不裁剪首尾空格）。
 *
 * 例如 `'a\n\n b \n'` → `['a', ' b ']`；空串与纯空白行文本 → `[]`。
 */
export function splitNonEmptyLines(text) {
  if (typeof text !== 'string') {
    throw new TypeError('splitNonEmptyLines: text must be a string');
  }
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}
