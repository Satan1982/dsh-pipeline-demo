// 「环境失败 ≠ 写错」的回归测试（2026-11-06）。
//
// 背景：Windows 沙箱 workspace-write 档禁止子进程开命名管道，`node --test` 每个测试文件
// 都要 spawn 子进程 → 30/30 spawn EPERM。以前这种失败和「代码写错」走同一条路：
// 推高 attempt、烧掉三次重试预算，最后一张好工单被判死，而且 agent 会去改根本没坏的测试。
//
// 这条链路有四段，每段都要有断言，否则任一段回退都没人发现：
//   verify.sh（识别 → exit 78）→ failures.mjs（归因为环境）
//   → dispatch.mjs（带 env 标记抛出 + 不写失败指纹）→ 调度器（单独计数、不推高 attempt、到头人工挂起）
//
// 断言方式说明：本文件不 import dispatch.mjs（它会起网络/锁），只做**源码级契约检查**加
// **一次真实子进程探测**。源码级断言必须锚定「唯一出现」的文本，不能用会恒真的切片。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { classifyCause } from './failures.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERIFY = readFileSync(path.join(ROOT, 'scripts', 'verify.sh'), 'utf8');
const DISPATCH = readFileSync(path.join(ROOT, 'ci', 'dispatch.mjs'), 'utf8');

test('verify.sh 有受限环境预检，并且退 78 而不是 1', () => {
  assert.equal(VERIFY.includes('exit 78'), true, 'verify.sh 缺 exit 78：环境失败会和测试失败混在一起');
  assert.equal(VERIFY.includes('spawnSync(process.execPath'), true, '缺子进程管道探针');
  assert.equal(VERIFY.includes('DSH_VERIFY_TEST_EPERM'), true, '缺自测开关，这条分支无法被验证');
  assert.equal(VERIFY.includes('ENV_FAIL'), true, '退出前必须打出可分类的 ENV_FAIL 标记');
  // 探针要能区分「EPERM」与「node 坏了」，否则两类问题会被同一个修法对待。
  assert.equal(VERIFY.includes('ERR:EPERM'), true, '探针要区分错误码');
  assert.equal(VERIFY.includes('NODE_FAIL'), true, 'node 自己跑不起来也要算环境问题');
  // 探针本身要能在「能 spawn」的机器上成功：这里就是那台机器的实测。
  const probe = spawnSync(process.execPath, ['-e', ''], { stdio: 'pipe' });
  assert.equal(probe.error ?? null, null, '本机应能正常 spawn：环境预检不应在正常机器上误报');
});

test('failures.mjs 把 spawn EPERM / ENV_FAIL / 沙箱 归到「环境」', () => {
  for (const text of [
    'spawn EPERM: 子进程无法启动',
    'ENV_FAIL: 门禁在受限环境里无法启动子进程（exit 78）',
    'Windows 沙箱禁止命名管道',
  ]) {
    assert.equal(classifyCause(text), '环境', `「${text}」应归为环境`);
  }
  // 不能把真写错的失败也吞进「环境」：对照样本仍须是「写错」。
  assert.equal(classifyCause('AssertionError: expected 2 but got 3'), '写错');
  assert.equal(classifyCause('verify: 断言基线不一致'), '基线');
});

test('dispatch 对 exit 78 / bash 没起来 都判为环境失败（带标记）', () => {
  // bash 没起来（spawn error）是环境；被 SIGKILL 的超时（同样是 code -1）不是——两者必须分开，
  // 否则一个真卡死的门禁会被当成环境失败重试两次再挂起，真问题被藏起来。
  assert.equal(DISPATCH.includes('Number(v.code) === 78 || v.spawnError === true'), true, 'spawn 失败与超时必须按不同字段区分');
  assert.equal(DISPATCH.includes('spawnError: true'), true, 'run() 要在 spawn 失败时打标记');
  assert.equal(DISPATCH.includes('timedOut = true'), true, '超时要单独标记，不能混进环境失败');
  assert.equal(DISPATCH.includes('return { ok: false, env: true'), true, 'verifyWorktree 必须返回结构化 env 标记');
  // 结构化标记要在 catch 里被优先使用，而不是只靠堆栈里的子串。
  assert.equal(DISPATCH.includes('const envFailure = e?.env === true'), true, 'catch 必须先看 e.env');
  // 环境失败不许写进失败指纹库（否则会当先验灌回 agent）。
  assert.equal(DISPATCH.includes('if (!gate.env) recordFailure('), true, '环境失败不能进失败指纹库');
});

test('环境失败单独计数：不推高 attempt，用尽后人工挂起（不是免费池挂起）', () => {
  assert.equal(DISPATCH.includes('const ENV_RETRIES = new Map()'), true);
  assert.equal(DISPATCH.includes('const ENV_RETRY_MAX = envLimit('), true, '环境上限要用消毒后的解析（NaN/负数不该变成 0 次）');
  // 环境分支必须先于免费池判定：否则 ENV_FAIL 文本可能被当成池子问题，挂起后等池子恢复。
  const envAt = DISPATCH.indexOf('const envFailure = e?.env === true');
  const poolAt = DISPATCH.indexOf('const poolDecision = freePoolDecision(');
  assert.equal(envAt > 0 && poolAt > 0 && envAt < poolAt, true, '环境失败分支必须排在免费池判定之前');
  const retry = 'return runTask(issue, attempt, reason);';
  assert.equal(DISPATCH.includes(retry), true, '重试必须沿用同一个 attempt（不推高重试预算）');
  // 用尽后必须走「人工挂起」：blockManual 写 gaveUp，recoverBlocked 不会再自动重投。
  assert.equal(DISPATCH.includes('await blockManual(issue, `环境失败'), true, '用尽后应人工挂起，而不是 blockTask（会被自动重投）');
  assert.equal(DISPATCH.includes('gaveUp: true'), true, '人工挂起要写 gaveUp，否则 recoverBlocked 还会自动重投');
});

test('重试计数在成功后清空（不跟着工单号永久累积）', () => {
  assert.equal(DISPATCH.includes('ENV_RETRIES.delete(n);'), true, '成功后要清环境计数');
  assert.equal(DISPATCH.includes('RATE_LIMIT_RETRIES.delete(n);'), true, '成功后要清限流计数');
});
