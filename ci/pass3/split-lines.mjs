/**
 * Split text into non-empty lines.
 *
 * Lines are split on `\n` / `\r\n`; lines that are only whitespace are dropped.
 * Every kept line is returned unchanged (no trimming of leading/trailing spaces).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitNonEmptyLines(text) {
  if (typeof text !== 'string') {
    throw new TypeError('splitNonEmptyLines expects a string');
  }
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}
