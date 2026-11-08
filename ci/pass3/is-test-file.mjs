// 测试文件判定（v3 P3）：Pass^3 任务清单里区分测试文件与普通源文件。
//
// 约定：只有以 '.test.mjs' / '.test.js' 结尾的才算法测试文件，
// 所以 'x.test'、'ci/x.mjs' 都不算。

const TEST_SUFFIXES = ['.test.mjs', '.test.js'];

export function isTestFile(name) {
  if (typeof name !== 'string') return false;
  return TEST_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
