// 运行态（持久暂停 / 只读体检 / 未知旗标拒绝）的回归测试（2026-11-06）。
//
// 三个必须成立的事实：
// ① 暂停是落盘的：进程重启后仍然停着（旧版 `PAUSE_CLAIM` 只是内存变量，重启即满血复活）；
// ② 状态文件读不出来时 fail-closed（当暂停处理，而不是「当作没事继续领单」）；
// ③ 未知旗标必须报错退出，绝不能静默掉进常驻轮询（`--status` 当初就是这么变成「起了个调度器」的）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { clearPaused, formatStatus, parseRuntime, readState, setPaused, stateFile, writeState, KNOWN_FLAGS } from './runtime-state.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-rt-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('没有状态文件＝没暂停（新仓库第一次跑不该被当成停着）', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'dsh-rt-nofile-'));
  try {
    assert.equal(readState(d).paused, false);
    assert.equal(existsSync(stateFile(d)), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('暂停写入盘里，重新读回来仍然是暂停（这是「重启不清零」的判据）', () => {
  const st = setPaused(dir, '日闸熔断');
  assert.equal(st.paused, true);
  const again = readState(dir); // 模拟新进程：只读文件，不共享内存
  assert.equal(again.paused, true);
  assert.equal(again.pausedWhy, '日闸熔断');
  assert.equal(readFileSync(stateFile(dir), 'utf8').includes('"paused": true'), true);
  clearPaused(dir);
  assert.equal(readState(dir).paused, false);
});

test('状态文件损坏时 fail-closed：当暂停处理，不当作可领单', () => {
  const f = stateFile(dir);
  writeFileSync(f, '{ this is not json');
  const st = readState(dir);
  assert.equal(st.paused, true, '读不出来还继续领单，等于日闸在状态未知时失效');
  assert.equal(st.corrupt, true);
  assert.equal(st.pausedWhy.includes('损坏'), true);
  writeState(dir, { paused: false, pausedAt: null, pausedWhy: null });
});

test('写盘是原子替换：不留下半截文件', () => {
  const f = stateFile(dir);
  writeState(dir, { paused: true, pausedAt: '2026-11-06T00:00:00.000Z', pausedWhy: 'x' });
  const raw = readFileSync(f, 'utf8');
  assert.equal(raw.trim().endsWith('}'), true);
  assert.equal(raw.includes('tmp-') , false);
});

test('未知旗标被识别出来（dispatch 据此 exit 2，而不是静默起常驻）', () => {
  const r = parseRuntime(['node', 'ci/dispatch.mjs', '--bogus', '--status']);
  assert.deepEqual(r.unknown, ['--bogus']);
  assert.equal(r.cmd, 'status');
  const ok = parseRuntime(['node', 'ci/dispatch.mjs', '--once', '--repos', 'repos.json']);
  assert.deepEqual(ok.unknown, [], '带值的旗标不该把值本身当未知旗标');
  assert.equal(ok.cmd, null);
  assert.equal(KNOWN_FLAGS.includes('--status'), true);
});

test('--status 输出含锁/暂停/花费三行，且暂停时写明原因', () => {
  setPaused(dir, '人工');
  const lines = formatStatus({
    mode: 'paused', lock: { pid: 123, mode: 'serve', at: '2026-11-06T00:00:00Z', alive: true, beatFresh: true },
    st: readState(dir), spendCny: 1.2345, dayMaxCny: 5, taskMaxCny: 0.5, events: ['failed@11-06 10:00'],
  });
  const text = lines.join('\n');
  assert.equal(/lock: pid=123/.test(text), true);
  assert.equal(/pause: 是（人工/.test(text), true);
  assert.equal(/spend: 今日 ¥1\.2345/.test(text), true);
  clearPaused(dir);
});
