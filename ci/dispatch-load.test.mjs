// 只加载 dispatcher，不执行它。目的：模块级错误（漏写的 const、TDZ、拼错的导入）
// 在 import 时就会抛，而 `node --check` 只看语法，抓不到。
// 这个文件存在的理由是一次真实事故：脱敏改写时误删了 `const TIMEOUT`，
// 门禁全绿、CI 全绿，但调度器一起来就 ReferenceError。
import test from 'node:test';
import assert from 'node:assert/strict';

test('dispatcher 模块可以被完整加载', async () => {
  process.env.DSH_DISPATCH_LOAD_ONLY = '1';
  process.env.DSH_PERMISSION_MODE = process.env.DSH_PERMISSION_MODE ?? 'workspace-write';
  const mod = await import('../ci/dispatch.mjs');
  assert.equal(typeof mod, 'object');
});
