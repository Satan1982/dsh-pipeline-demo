// ci/pass3/titleize.mjs —— kebab-case 转标题。
//
// 规则：按 '-' 切分，每段首字母大写、其余原样，再用空格连接；空串返回空串。

export function titleize(text) {
  if (typeof text !== 'string') {
    throw new TypeError('titleize expects a string');
  }
  if (text.length === 0) return '';
  return text
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
