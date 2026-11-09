import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gateLogName, writeGateLog } from './gate-log.mjs';

test('gateLogName 按 issue/attempt 命名：同一单的每次尝试各留一份', () => {
  assert.equal(gateLogName(229, 1), 'gate-issue-229-attempt-1.log');
  assert.equal(gateLogName(7, 3), 'gate-issue-7-attempt-3.log');
});

test('writeGateLog 落盘门禁 stdout，并把 exit 与 gate sha 写在头两行', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-log-'));
  try {
    const r = writeGateLog(dir, { issue: 229, attempt: 2, code: 0, stdout: 'ok 1 - 有输出\n', sha: 'abc123' });
    assert.equal(r.ok, true);
    assert.equal(path.basename(r.file), 'gate-issue-229-attempt-2.log');
    const text = readFileSync(r.file, 'utf8');
    assert.match(text, /^exit=0/);
    assert.match(text, /gate_bytes_sha256=abc123/);
    assert.match(text, /ok 1 - 有输出/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeGateLog 对空输出也留一行占位，别让日志文件是零字节', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-log-'));
  try {
    const r = writeGateLog(dir, { issue: 1, attempt: 1, code: 1, stdout: '' });
    assert.equal(r.ok, true);
    assert.match(readFileSync(r.file, 'utf8'), /门禁没有任何输出/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeGateLog 落盘失败只返回 ok:false，不抛（日志不是交付物）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-log-'));
  try {
    const blocker = path.join(dir, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const r = writeGateLog(blocker, { issue: 1, attempt: 1, code: 0, stdout: 'x' });
    assert.equal(r.ok, false);
    assert.match(String(r.why), /./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
