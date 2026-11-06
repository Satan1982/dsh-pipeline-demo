// 无人值守执行入口的「默认档」回归测试。
//
// 为什么要有: 2026-11-06 之前 `ci/headless-task.sh` 默认给 `danger-full-access` 并注入三把真 key。
// 那天把默认改成「本地 Lemonade + workspace-write + 无 key」，改完之后 281 条测试**一条都没拦**
// ——把 :61 的默认 patch 换回 .secrets 那份，所有测试照样绿。这几条静态断言就是那道门。
//
// 只做文本断言、不 spawn bash：本机子进程管道受限会报 spawn EPERM，
// 拿它去测「默认值」会让测试本身变成环境问题的受害者（门禁失败 ≠ 代码坏）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = readFileSync(path.join(ROOT, 'ci', 'headless-task.sh'), 'utf8');
const DISPATCH = readFileSync(path.join(ROOT, 'ci', 'dispatch.mjs'), 'utf8');

test('默认权限档是 workspace-write，且没有任何代码路径默认设 danger-full-access', () => {
  assert.equal(SCRIPT.includes('DSH_PERMISSION_MODE:-danger-full-access'), false);
  assert.equal(SCRIPT.includes('DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-workspace-write}"'), true);
});

test('默认不注入真 key：三把 key 的注入都关在 ALLOW_CREDS 分支里', () => {
  assert.equal(SCRIPT.includes('DSH_HEADLESS_ALLOW_CREDS'), true);
  // 真 key 变量名必须出现在这个开关之后（也就是那个 else 的反面），不能出现在文件前半段的默认路径
  const gateAt = SCRIPT.indexOf('if [ "$ALLOW_CREDS" = "1" ]; then');
  assert.notEqual(gateAt, -1, '缺少 ALLOW_CREDS 开关分支');
  for (const key of ['SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY', 'MODELSCOPE_API_TOKEN']) {
    const at = SCRIPT.indexOf(key);
    assert.notEqual(at, -1, `${key} 的注入逻辑被删了？`);
    assert.ok(at > gateAt, `${key} 出现在开关之前，等于默认注入`);
  }
});

test('默认 patch 指向仓内无凭据的本地路由文件', () => {
  assert.equal(SCRIPT.includes('PATCH="${DSH_HEADLESS_PATCH:-$ROOT/ci/headless-local.yml}"'), true);
  const local = path.join(ROOT, 'ci', 'headless-local.yml');
  assert.equal(existsSync(local), true, 'ci/headless-local.yml 不存在，默认档会 fail-closed');
  const yml = readFileSync(local, 'utf8');
  assert.equal(/sk-[A-Za-z0-9]{10,}/.test(yml), false, '本地路由文件里出现了疑似密钥字面量');
  assert.equal(yml.includes('127.0.0.1:13305/api/v1'), true);
  assert.equal(yml.includes('/api/v1'), true);
});

test('调度器只在显式升级时才 opt-in 凭据，且不把父进程的同名变量漏给 agent', () => {
  assert.equal(DISPATCH.includes("if (runEnv.DSH_HEADLESS_PATCH) runEnv.DSH_HEADLESS_ALLOW_CREDS = '1';"), true);
  assert.equal(DISPATCH.includes("DSH_HEADLESS_PATCH: env.DSH_HEADLESS_PATCH || ''"), true);
  assert.equal(DISPATCH.includes("DSH_HEADLESS_ALLOW_CREDS: env.DSH_HEADLESS_ALLOW_CREDS || ''"), true);
});

test('干跑输出仍是 5 行契约（探活只走 stderr）', () => {
  const dry = SCRIPT.slice(SCRIPT.indexOf('if [ "${DSH_HEADLESS_DRY:-}" = "1" ]; then'));
  const body = dry.slice(0, dry.indexOf('\nfi\n'));
  // keys/patch/lemonade/patch_exists 与 mode 共 5 条 stdout 行；带 2>&1 的探活警告不算
  const stdoutEchoes = body.split('\n').filter((l) => /^  echo ".*"$/.test(l));
  assert.equal(stdoutEchoes.length, 5, `干跑 stdout 行数应恒为 5，实际 ${stdoutEchoes.length}`);
  assert.equal(body.includes('-o /dev/null -w'), true, '探活被删了？');
});
