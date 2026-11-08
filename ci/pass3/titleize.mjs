// kebab-case 转标题：按 '-' 切分，每段首字母大写、其余原样，用空格连接；空串返回空串。
export function titleize(text) {
  if (text === '') return '';
  return text
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
