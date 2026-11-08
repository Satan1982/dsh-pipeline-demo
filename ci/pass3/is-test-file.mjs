// 测试文件判定（P3-09 r3）。
//
// 只回答一个问题：这个文件名看起来是不是测试文件。判据是后缀，不做路径规范化，
// 也不做大小写折叠——调用方传进来的就是仓库里的路径/文件名。
// `.test.js`（src 下的单测）与 `.test.mjs`（ci 下的单测）都要认，其余一律 false。

/**
 * @param {string} name 文件路径或文件名
 * @returns {boolean} 是否以 `.test.mjs` 或 `.test.js` 结尾
 */
export function isTestFile(name) {
  return typeof name === 'string' && (name.endsWith('.test.mjs') || name.endsWith('.test.js'));
}
