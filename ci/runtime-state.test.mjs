// 运行态（持久暂停 / 只读体检 / 旗标解析）的回归测试（2026-11-06）。
//
// 必须成立的事实：
// ① 暂停是落盘的：进程重启后仍然停着（旧版 `PAUSE_CLAIM` 只是内存变量，重启即满血复活）；
// ② 状态文件读不出来时 fail-closed（当暂停处理，而不是「当作没事继续领单」）；
// ③ 未知旗标必须报错退出，绝不能静默掉进常驻轮询（`--status` 当初就是这么变成「起了个调度器」的）；
// ④ `--serve` 是合法旗标：`startResident()` 正是用它拉起常驻进程，漏认会让补位进程秒死；
// ⑤ 同一行给多个命令必须报冲突，而不是静默「后写者赢」。
//
// 每个用例自己建临时目录：共享目录时，中间某个用例 throw 会把状态留给后面的用例，
// 变成一串假红，反过来又掩盖真问题。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { clearPaused, formatStatus, parseRuntime, readState, setPaused, stateFile, writeState, KNOWN_FLAGS } from './runtime-state.mjs';

const withDir = (fn) => {
  const d = mkdtempSync(path.join(tmpdir(), 'dsh-rt-'));
  try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
};

test('没有状态文件＝没暂停（新仓库第一次跑不该被当成停着）', () => withDir((d) => {
  assert.equal(readState(d).paused, false);
  assert.equal(existsSync(stateFile(d)), false);
}));

test('暂停写入盘里，重新读回来仍然是暂停（这是「重启不清零」的判据）', () => withDir((d) => {
  const st = setPaused(d, '日闸熔断');
  assert.equal(st.paused, true);
  const again = readState(d); // 模拟新进程：只读文件，不共享内存
  assert.equal(again.paused, true);
  assert.equal(again.pausedWhy, '日闸熔断');
  assert.equal(readFileSync(stateFile(d), 'utf8').includes('"paused": true'), true);
  clearPaused(d);
  assert.equal(readState(d).paused, false);
}));

test('状态文件损坏时 fail-closed：当暂停处理，不当作可领单', () => withDir((d) => {
  writeFileSync(stateFile(d), '{ this is not json');
  const st = readState(d);
  assert.equal(st.paused, true, '读不出来还继续领单，等于日闸在状态未知时失效');
  assert.equal(st.corrupt, true);
  assert.equal(st.pausedWhy.includes('损坏'), true);
}));

test('写盘是原子替换：不留下半截文件', () => withDir((d) => {
  writeState(d, { paused: true, pausedAt: '2026-11-06T00:00:00.000Z', pausedWhy: 'x' });
  const raw = readFileSync(stateFile(d), 'utf8');
  assert.equal(raw.trim().endsWith('}'), true);
  assert.equal(raw.includes('tmp-'), false);
}));

test('未知旗标被识别出来（dispatch 据此 exit 2，而不是静默起常驻）', () => {
  const r = parseRuntime(['node', 'ci/dispatch.mjs', '--bogus', '--status']);
  assert.deepEqual(r.unknown, ['--bogus']);
  assert.equal(r.cmd, 'status');
  const ok = parseRuntime(['node', 'ci/dispatch.mjs', '--once', '--repos', 'repos.json']);
  assert.deepEqual(ok.unknown, [], '带值的旗标不该把值本身当未知旗标');
  assert.equal(ok.cmd, null);
  assert.equal(KNOWN_FLAGS.includes('--status'), true);
});

test('--serve 是合法旗标（常驻补位进程必须能起来）', () => {
  const r = parseRuntime(['node', 'ci/dispatch.mjs', '--serve']);
  assert.deepEqual(r.unknown, [], '--serve 被当成未知旗标会让 startResident() 拉起的进程 exit 2，常驻永远起不来');
  assert.equal(r.cmd, null, '--serve 是模式旗标，不是子命令');
});

test('-h / -? 等价于 --help', () => {
  for (const flag of ['-h', '-?']) {
    const r = parseRuntime(['node', 'ci/dispatch.mjs', flag]);
    assert.equal(r.cmd, 'help', `${flag} 应打印用法而不是 exit 2`);
    assert.deepEqual(r.unknown, []);
  }
});

test('同一行给多个命令要报冲突（否则 --pause --status 会静默不暂停）', () => {
  const r = parseRuntime(['node', 'ci/dispatch.mjs', '--pause', '--why', '熔断', '--status']);
  assert.equal(r.cmd, null);
  assert.equal(r.conflict, 'pause,status');
  assert.equal(r.why, '熔断', '冲突时也要能取到 --why，报错信息才有用');
});

test('--status 输出含锁/暂停/花费三行，且暂停时写明原因', () => withDir((d) => {
  setPaused(d, '人工');
  const lines = formatStatus({
    mode: 'paused', lock: { pid: 123, mode: 'serve', at: '2026-11-06T00:00:00Z', alive: true, beatFresh: true },
    st: readState(d), spendCny: 1.2345, dayMaxCny: 5, taskMaxCny: 0.5, events: ['failed@11-06 10:00'],
  });
  const text = lines.join('\n');
  assert.equal(/lock: pid=123/.test(text), true);
  assert.equal(/pause: 是（人工/.test(text), true);
  assert.equal(/spend: 今日 ¥1\.2345/.test(text), true);
}));

test('--unattended 是合法旗标（计划任务动作里带它，不能被 exit 2 挡掉）', () => {
  const r = parseRuntime(['node', 'ci/dispatch.mjs', '--once', '--unattended']);
  assert.deepEqual(r.unknown, [], '--unattended 被当成未知旗标会让计划任务每轮 exit 2，无人值守永远不生效');
  assert.equal(KNOWN_FLAGS.includes('--unattended'), true);
});
