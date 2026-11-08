/**
 * titleize — 把 kebab-case 文本转成标题。
 *
 * 规则：按 '-' 切分，每段首字母大写、其余原样，用空格连接；空串返回空串。
 * 例：'hello-world' -> 'Hello World'，'a-b-c' -> 'A B C'，'' -> ''。
 */
export function titleize(text) {
  if (text === '') return '';
  return String(text)
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
