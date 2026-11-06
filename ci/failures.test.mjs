import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  normalize, signature, fingerprint, recordFailure, lookup, formatPriorFailures, loadStore, repairStore, trimStore,
  classifyCause, statsByCause, CAUSES,
} from './failures.mjs';

test('normalize 抹掉每次都会变的部分', () => {
  const a = 'Error: verify failed at 2026-10-25T01:02:03.000Z in C:\\work\\.worktrees\\issue-25 after 42s (commit a1b2c3d4e5f6)';
  const b = 'Error: verify failed at 2026-10-26T09:11:12.000Z in C:\\work\\.worktrees\\issue-31 after 7s (commit ffffffffffff)';
  assert.equal(normalize(a), normalize(b));
  assert.ok(!normalize(a).includes('a1b2c3d4e5f6'));
  assert.ok(normalize(a).includes('<path>'));
});

test('相同根因不同噪声得到同一指纹', () => {
  const a = 'exit code 1\n拒绝：测试数量从 17 降到 16（禁止删测试凑绿）\n  at run (C:\\work\\x.mjs:10:5)';
  const b = 'exit code 1\n拒绝：测试数量从 17 降到 16（禁止删测试凑绿）\n  at run (E:/other/y.mjs:99:1)';
  assert.equal(fingerprint(a), fingerprint(b));
});

test('数字本身仍参与指纹（降 1 个和降 5 个不是同一件事）', () => {
  const a = '拒绝：测试数量从 17 降到 16（禁止删测试凑绿）';
  const b = '拒绝：测试数量从 17 降到 12（禁止删测试凑绿）';
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('不同根因得到不同指纹', () => {
  const a = 'exit code 1\n拒绝：测试数量从 17 降到 16（禁止删测试凑绿）';
  const b = 'exit code 1\nremote: Repository not found.';
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('栈帧不进入签名，签名长度有界', () => {
  const text = 'Error: boom\n  at a (x.js:1:1)\n  at b (y.js:2:2)\nnode:internal/process/task_queues:95:5';
  const sig = signature(text);
  assert.ok(!sig.includes('at a'));
  assert.ok(!sig.includes('node:internal'));
  assert.ok(sig.length <= 600);
});

test('recordFailure 追加写、lookup 折叠计数', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'failstore-'));
  const file = path.join(dir, 'docs/failures.jsonl');
  try {
    const text = 'Error: same thing C:\\work\\a after 3s';
    recordFailure({ text, issue: 1, attempt: 1, reason: '第一次' }, file);
    recordFailure({ text: text.replace('C:\\work\\a', 'C:\\work\\b').replace('3s', '9s'), issue: 2, attempt: 1, reason: '第二次', fix: '删掉坏行' }, file);
    const rec = lookup(text, file);
    assert.ok(rec);
    assert.equal(rec.count, 2);
    assert.deepEqual(rec.issues, [1, 2]);
    assert.equal(rec.fix, '删掉坏行');
    assert.equal(loadStore(file).size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatPriorFailures 命中时给出上次根因与修法，未命中返回空串', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'failstore-'));
  const file = path.join(dir, 'docs/failures.jsonl');
  try {
    assert.equal(formatPriorFailures('Error: 全新错误', file), '');
    const text = 'Error: 老毛病 C:\\work\\x 12s';
    recordFailure({ text, issue: 7, attempt: 1, reason: '断言被改写', fix: '恢复断言并改代码' }, file);
    const out = formatPriorFailures(text.replace('C:\\work\\x', 'C:\\work\\y').replace('12s', '40s'), file);
    assert.ok(out.includes('同一个根因出现过 1 次'));
    assert.ok(out.includes('恢复断言并改代码'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一根因不同尾巴合并成同一指纹', () => {
  const base = 'Error: 独立门禁未通过（调度器自己跑的 bash scripts/verify.sh，不采信 agent 自述）：';
  const a = `${base}\n拒绝：测试数量从 40 降到 39\n    at runTask (x:1)`;
  const b = `${base}\n拒绝：断言数量从 98 降到 90\n    at runTask (y:9)`;
  const c = `${base}\n完全不同的尾部输出`;
  assert.equal(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint(a), fingerprint(c));
});

test('Error: 前缀不影响指纹', () => {
  const a = 'Error: agent 未产生任何改动（exit=0）';
  const b = 'agent 未产生任何改动（exit=0）';
  assert.equal(fingerprint(a), fingerprint(b));
});

test('agent 未动手的 exit 0 与 1 算同一种', () => {
  assert.equal(fingerprint('agent 未产生任何改动（exit=0）'), fingerprint('agent 未产生任何改动（exit=1）'));
});

test('命中不同规则仍是不同指纹', () => {
  const a = 'Error: 评审层拒绝（改动未推送）：\n✗ 阻断 [baseline-unsynced] 忘了 bless';
  const b = 'Error: 评审层拒绝（改动未推送）：\n✗ 阻断 [debug-residue] 留了 BROKEN';
  assert.notEqual(fingerprint(a), fingerprint(b));
  // 同一条规则的两次拒绝仍应合并
  const a2 = 'Error: 评审层拒绝（改动未推送）：\n✗ 阻断 [baseline-unsynced] 另一张工单';
  assert.equal(fingerprint(a), fingerprint(a2));
});

test('repairStore 用新算法重算并去重', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'failrepair-'));
  const file = path.join(dir, 'docs/failures.jsonl');
  try {
    const mk = (fp, issue, attempt, reason) => JSON.stringify({ fp, sig: 'old', issue, attempt, reason, at: `2026-10-25T00:00:0${attempt}.000Z` });
    recordFailure({ text: '独立门禁未通过：\n尾巴 A', issue: 1, attempt: 1 }, file);
    recordFailure({ text: '独立门禁未通过：\n尾巴 B', issue: 1, attempt: 2 }, file);
    // 手工塞一条旧指纹 + 完全重复的一行（模拟老算法留下的碎片）
    const dup = mk('deadbeefdeadbeef', 9, 1, '独立门禁未通过：\n尾巴 C');
    appendFileSync(file, `${dup}\n${dup}\n`);
    const res = repairStore(file);
    // 两条同根因但 (issue, attempt) 不同，是两次独立失败，不合并；
    // 重复行按 (fp, issue, attempt) 折叠。而老算法留下的 deadbeef 碎片在这里被重算回
    // 同一个根因指纹 —— 这正是 repair 的意义：碎片收敛回一条主线。
    assert.equal(res.after, 3);
    assert.equal(res.fps, 1);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(lines.every((r) => /^[0-9a-f]{16}$/.test(r.fp)), '所有记录的指纹都被重算成 16 位');
    assert.equal(new Set(lines.map((r) => r.fp)).size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trimStore 把记忆库剪到上限并保留最新的记录', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-fail-trim-'));
  const file = path.join(dir, 'failures.jsonl');
  try {
    for (let i = 0; i < 6; i += 1) {
      recordFailure({ text: `根因 ${i}\n尾巴`, issue: i, attempt: 1 }, file);
    }
    const res = trimStore(file, 2);
    assert.equal(res.before, 6);
    assert.equal(res.after, 2);
    assert.equal(res.dropped, 4);
    const left = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(left.length, 2);
    assert.deepEqual(left.map((r) => r.issue), [4, 5], '保留最新的两条');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyCause 把真实失败文本归到三类', () => {
  const cases = [
    ['Error: [headless] llm-rate-limit｜agent 未产生任何改动（exit=1）', '环境'],
    ['Error: git fetch 失败（退避重试 6 次 + SSH 端点）: Could not read from remote repository.', '环境'],
    ['spawn ENOENT', '环境'],
    ['Error: 评审层拒绝（改动未推送）：\n✗ 阻断 [baseline-unsynced] 忘了 bless', '基线'],
    ['基线快照未同步，先跑 refresh-baseline', '基线'],
    ['ReferenceError: path is not defined', '写错'],
    ['拒绝：测试数量从 17 降到 16（禁止删测试凑绿）', '写错'],
    ['Error: 独立门禁未通过（调度器自己跑的 bash scripts/verify.sh，不采信 agent 自述）：', '写错'],
    ['exit code 1', '未知'],
    ['', '未知'],
  ];
  for (const [text, want] of cases) {
    assert.equal(classifyCause(text), want, `归错类：${JSON.stringify(text.slice(0, 40))}`);
  }
});

test('环境优先于基线（限流时基线比对本身也不可信）', () => {
  assert.equal(classifyCause('llm-rate-limit 后 [baseline-unsynced] 未同步'), '环境');
  assert.ok(CAUSES.includes('未知'), '未知也是合法归因，不能当空串处理');
});

test('recordFailure 写入 cause，旧记录读取时现场归类', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'failcause-'));
  const file = path.join(dir, 'docs/failures.jsonl');
  try {
    const envText = 'Error: [headless] llm-rate-limit｜agent 未产生任何改动（exit=1）';
    const bugText = 'ReferenceError: path is not defined';
    const badText = '✗ 阻断 [baseline-unsynced] 忘了 bless';
    const a = recordFailure({ text: envText, issue: 1, attempt: 1, reason: envText }, file);
    const b = recordFailure({ text: bugText, issue: 2, attempt: 1, reason: bugText }, file);
    const c = recordFailure({ text: badText, issue: 3, attempt: 1, reason: badText }, file);
    assert.equal(a.cause, '环境');
    assert.equal(b.cause, '写错');
    assert.equal(c.cause, '基线');

    // 模拟加字段之前写下的老记录：没有 cause，靠 reason 现算
    appendFileSync(file, `${JSON.stringify({ fp: 'deadbeefdeadbeef', sig: 'x', issue: 4, attempt: 1, reason: 'ECONNRESET 后重试仍失败', at: '2026-10-25T00:00:00.000Z' })}\n`);
    const store = loadStore(file);
    assert.equal(store.get('deadbeefdeadbeef').cause, '环境');

    const stats = statsByCause(file);
    const byCause = Object.fromEntries(stats.map((s) => [s.cause, s]));
    assert.deepEqual(stats.map((s) => s.cause), ['环境', '基线', '写错']);
    assert.equal(byCause['环境'].records, 2);
    assert.equal(byCause['环境'].fps, 2);
    assert.deepEqual(byCause['写错'].issues, [2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('statsByCause 空库返回空数组', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'failcause-empty-'));
  try {
    assert.deepEqual(statsByCause(path.join(dir, 'nope.jsonl')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
