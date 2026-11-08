// isTestFile：测试文件判定。
//
// 只按扩展名判定，不限制目录：name 以 '.test.mjs' 或 '.test.js' 结尾即测试文件。
// 判的是「文件名/路径」，不是「仓库内相对路径」，所以 'x.test.mjs' 也返回 true。

/**
 * @param {string} name 文件名或路径
 * @returns {boolean} 是否为测试文件
 */
export function isTestFile(name) {
  return typeof name === 'string' && (name.endsWith('.test.mjs') || name.endsWith('.test.js'));
}
