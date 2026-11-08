// 无人值守执行入口的「默认档」回归测试（2026-11-08 起本地大模型档已删除）。
//
// 为什么要有: 2026-11-06 之前 `ci/headless-task.sh` 默认给 `danger-full-access` 并注入三把真 key；
// 那次改默认值之后 281 条测试一条都没拦。这几条静态断言就是那道门。
// 2026-11-08 用户裁决「新方案以后都停用本地大模型」后，默认本地 Lemonade 也删了：
// 入口只认显式 DSH_HEADLESS_PATCH，缺 patch 就 fail-closed。
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
  const gateAt = SCRIPT.indexOf('if [ "$ALLOW_CREDS" = "1" ]; then');
  assert.notEqual(gateAt, -1, '缺少 ALLOW_CREDS 开关分支');
  for (const key of ['SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY', 'MODELSCOPE_API_TOKEN']) {
    const at = SCRIPT.indexOf(key);
    assert.notEqual(at, -1, `${key} 的注入逻辑被删了？`);
    assert.ok(at > gateAt, `${key} 出现在开关之前，等于默认注入`);
  }
});

test('入口不再挂本地模型路由（文件、端口、预热逻辑都不许残留）', () => {
  for (const needle of ['headless-local.yml', '13305', 'LEMONADE', '预热本地模型', '/health']) {
    assert.equal(SCRIPT.includes(needle), false, `入口仍残留本地路由：${needle}`);
  }
  assert.equal(existsSync(path.join(ROOT, 'ci', 'headless-local.yml')), false, '本地路由文件应已删除');
});

test('路由 patch 只来自显式环境变量，缺省为空', () => {
  assert.equal(SCRIPT.includes('PATCH="${DSH_HEADLESS_PATCH:-}"'), true);
  assert.equal(SCRIPT.includes('ci/headless-local.yml'), false);
});

test('缺 patch 时 fail-closed：报错并退出 1，不回退任何本地档', () => {
  assert.match(SCRIPT, /未指定模型路由 patch/u);
  const at = SCRIPT.indexOf('未指定模型路由 patch');
  assert.ok(SCRIPT.slice(at).includes('exit 1'), '缺 patch 分支没有 exit 1');
});

test('调度器重投只看云端：本地档开关与探活代码已删除', () => {
  assert.equal(DISPATCH.includes('localLaneEnabled'), false, 'dispatch 仍引用本地档开关');
  assert.equal(DISPATCH.includes('13305'), false, 'dispatch 仍残留本地端口');
  assert.equal(DISPATCH.includes('laneVerdict'), false, 'dispatch 仍残留本地槽位判据');
});

test('干跑输出仍是 5 行契约（探活已删，local=off 为固定值）', () => {
  const dry = SCRIPT.slice(SCRIPT.indexOf('if [ "${DSH_HEADLESS_DRY:-}" = "1" ]; then'));
  const body = dry.slice(0, dry.indexOf('\nfi\n'));
  const stdoutEchoes = body.split('\n').filter((l) => /^  echo ".*"$/.test(l));
  assert.equal(stdoutEchoes.length, 5, `干跑 stdout 行数应恒为 5，实际 ${stdoutEchoes.length}`);
  assert.equal(body.includes('local=off'), true);
});

test('入口不经 dsh.cmd 传任务（cmd.exe 会把任务里的 < > 当重定向）', () => {
  assert.equal(SCRIPT.includes('ELECTRON_RUN_AS_NODE=1 exec'), true, '入口没绕过 cmd.exe');
  assert.equal(SCRIPT.includes('dsh-desktop-host/lib/cli.js'), true, '入口没指向 node CLI');
});

test('继承来的 DSH_SESSION_ID 不被当成续跑会话', () => {
  assert.equal(SCRIPT.includes('[ -n "${DSH_HEADLESS_RESUME:-}" ] && [ -n "${DSH_SESSION_ID:-}" ]'), true);
  assert.equal(DISPATCH.includes("runEnv.DSH_HEADLESS_RESUME = resumeId ? '1' : '';"), true);
});

test('clean 环境带上 Windows 生存变量（否则 bash.exe 0xC0000142）', () => {
  assert.equal(DISPATCH.includes('function winEnv()'), true, '缺少 winEnv()');
  assert.match(DISPATCH, /WIN_KEEP = \[[^\]]*'SystemRoot'/u, 'winEnv 必须带 SystemRoot');
  assert.match(DISPATCH, /env: \{ \.\.\.winEnv\(\), \.\.\.scrubbedEnv\(\)/u, 'headless 的 clean env 没带上 winEnv');
});
