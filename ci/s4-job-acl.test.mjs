import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardenJobDir, DEFAULT_JOB_DIR, JOBS_ROOT } from '../ci/s4-job.mjs';

test('DEFAULT_JOB_DIR 已迁到 ProgramData（不再落在工作区）', () => {
  assert.equal(path.resolve(DEFAULT_JOB_DIR).toLowerCase().startsWith(path.resolve(JOBS_ROOT).toLowerCase()), true);
  assert.equal(DEFAULT_JOB_DIR.includes('.worktrees'), false);
});

test('ACL 只对 ProgramData jobDir 生效：临时目录直接跳过（不拖慢自检、不要求管理员）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 's4job-'));
  mkdirSync(path.join(dir, 'x'), { recursive: true });
  writeFileSync(path.join(dir, 'job.json'), '{}');
  const r = hardenJobDir(dir);
  assert.equal(r.skipped, true);
  assert.equal(r.ok, false);
  assert.match(r.why, /跳过 ACL/);
});
