import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareJob, WORKTREE_ROOT } from './s4-job.mjs';

function withJob(fn) {
  const cwd = path.join(WORKTREE_ROOT, '.s4', `env-test-${process.pid}`);
  mkdirSync(cwd, { recursive: true });
  const jobDir = mkdtempSync(path.join(os.tmpdir(), 's4env-'));
  try {
    return fn({ cwd, jobDir });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(jobDir, { recursive: true, force: true });
  }
}

test('prepareJob 只把一次性 token 写进 job.env，其它变量被丢弃', () => {
  withJob(({ cwd, jobDir }) => {
    const job = prepareJob({
      task: 'x',
      cwd,
      jobDir,
      env: { DSH_PROXY_TOKEN: 'abc', MODELSCOPE_API_TOKEN: 'x', DEEPSEEK_API_KEY: 'y' },
    });
    assert.deepEqual(job.env, { DSH_PROXY_TOKEN: 'abc' });
    const onDisk = JSON.parse(readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
    assert.deepEqual(onDisk.env, { DSH_PROXY_TOKEN: 'abc' });
  });
});

test('prepareJob 没有 env 时不写 job.env（默认无代理）', () => {
  withJob(({ cwd, jobDir }) => {
    const job = prepareJob({ task: 'x', cwd, jobDir });
    assert.equal(job.env, undefined);
    assert.equal('env' in JSON.parse(readFileSync(path.join(jobDir, 'job.json'), 'utf8')), false);
  });
});
