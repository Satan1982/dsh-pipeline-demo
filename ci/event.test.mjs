// 停机事件 CLI 的回归测试：顺序（ALERT 先于 event）、失败不上抛、退出码语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALERT_PREFIX, runCli, recordEvent } from './event.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'event-'));

test('recordEvent：先落 ALERT，再把事件写进 events.jsonl', () => {
  const dir = tmp();
  try {
    const alertDir = path.join(dir, 'alerts');
    const events = path.join(dir, 'events.jsonl');
    const r = recordEvent({ kind: 'failed', issue: 42, why: '验收命令不可判负', at: '2026-11-06T19:00:00.000Z', alertDir, eventsFile: events });
    assert.equal(r.ok, true);
    const files = readdirSync(alertDir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith(ALERT_PREFIX));
    const body = readFileSync(r.alert, 'utf8');
    assert.ok(body.includes('#42'));
    assert.ok(body.includes('验收命令不可判负'));
    const rec = JSON.parse(readFileSync(events, 'utf8').trim());
    assert.equal(rec.kind, 'failed');
    assert.equal(rec.issue, 42);
    assert.equal(rec.at, '2026-11-06T19:00:00.000Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('events 写不进去时不抛，ALERT 仍然是成功产物', () => {
  const dir = tmp();
  try {
    const alertDir = path.join(dir, 'alerts');
    const events = path.join(dir, 'events-dir');
    mkdirSync(events); // 目标是目录：appendFileSync 会 EISDIR，模拟「日志写不进去」
    const r = recordEvent({ why: '磁盘满', at: '2026-11-06T19:00:00.000Z', alertDir, eventsFile: events });
    assert.equal(r.ok, true, 'ALERT 写成即算成功');
    assert.equal(r.event, null);
    assert.ok(r.errors.some((e) => e.includes('写事件失败')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runCli：缺 --why / 未知参数 → 2；正常 → 0', () => {
  const dir = tmp();
  const outs = [];
  const errs = [];
  const io = { out: (s) => outs.push(s), err: (s) => errs.push(s) };
  try {
    assert.equal(runCli([], io), 2);
    assert.equal(runCli(['--bogus'], io), 2);
    const code = runCli(['--why', '池子耗尽', '--issue', '7', '--events', path.join(dir, 'e.jsonl'),
      '--alert-dir', path.join(dir, 'a'), '--no-toast'], io);
    assert.equal(code, 0);
    assert.ok(outs.some((s) => s.includes('ALERT 已写')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
