// 锁心跳的回归测试。
//
// 为什么要有：2026-11-07 00:31 实测，常驻调度器在 pollOnce 里跑单（#95）时锁的 at 不再刷新，
// 21 分钟后另一个进程判「陈旧锁」接管，正在跑的单被孤儿化、issue 被重新领取。
// 心跳必须跟轮询循环解耦——用独立定时器续租，间隔小于 3 分钟的判陈旧阈值。
//
// 只做文本断言、不 spawn：子进程管道在本机受限，测定时器行为会让测试自己变成环境问题的受害者。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DISPATCH = readFileSync(path.join(ROOT, 'ci', 'dispatch.mjs'), 'utf8');

test('锁心跳有独立定时器，且被接管后自己停表', () => {
  assert.notEqual(DISPATCH.indexOf('LOCK_BEAT_INTERVAL_MS'), -1, 'LOCK_BEAT_INTERVAL_MS 不见了：心跳又回到轮询循环里了？');
  const at = DISPATCH.indexOf('beatTimer = setInterval(');
  assert.notEqual(at, -1, '没有得到独立定时器：心跳只剩轮询循环里那份');
  const block = DISPATCH.slice(at, at + 900);
  assert.match(block, /ownsLock\(\)/, '定时器里要确认锁还是自己的，别写别人的锁');
  assert.match(block, /clearInterval\(beatTimer\)/, '被接管后要停表');
});

test('心跳间隔小于判陈旧阈值（默认 3 分钟）', () => {
  const m = DISPATCH.match(/DSH_LOCK_BEAT_INTERVAL_MS \?\? ([0-9_]+)/u);
  assert.ok(m, '缺少心跳间隔的默认值');
  const interval = Number(m[1].replaceAll('_', ''));
  assert.ok(Number.isFinite(interval) && interval > 0, `心跳间隔不合法：${m[1]}`);
  assert.ok(interval < 3 * 60 * 1000, `心跳间隔 ${interval}ms 不小于判陈旧阈值 180000ms，跑单期间仍会被接管`);
});

test('跑单期间不会再写一份「轮询循环心跳」（避免两处写锁文件）', () => {
  assert.equal(DISPATCH.includes('心跳：每轮把锁的时间刷成现在'), false, '旧的循环内心跳又回来了');
});
