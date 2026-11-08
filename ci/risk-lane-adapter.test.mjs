import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRunJs, parseRunExit, runHighRiskAdapter } from './risk-lane.mjs';

// docs/89 §3.6：high-risk 适配器只做薄适配——退出码映射必须 fail-closed，spawn 失败也必须拒。
function tmpDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-risk-adapter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parseRunExit 映射 0..6，未知码 fail-closed', () => {
  assert.equal(parseRunExit(0).ok, true);
  assert.equal(parseRunExit(2).reason, '写集越界/入口产物');
  assert.equal(parseRunExit(3).reason, '合并冲突');
  assert.equal(parseRunExit(4).reason, '验收/探针/质疑者失败');
  assert.equal(parseRunExit(5).reason, 'worker 失败');
  assert.equal(parseRunExit(6).reason, '规格闸/工具漂移');
  assert.equal(parseRunExit(99).ok, false);
  assert.match(parseRunExit(99).reason, /未知退出码/);
});

test('findRunJs 支持 DSH_PIPELINE_RUN 覆盖', (t) => {
  const dir = tmpDir(t);
  const fake = path.join(dir, 'run.mjs');
  writeFileSync(fake, 'process.exit(0)\n');
  const prev = process.env.DSH_PIPELINE_RUN;
  process.env.DSH_PIPELINE_RUN = fake;
  try {
    assert.equal(findRunJs(dir), fake);
  } finally {
    if (prev === undefined) delete process.env.DSH_PIPELINE_RUN;
    else process.env.DSH_PIPELINE_RUN = prev;
  }
});

test('runHighRiskAdapter：exit 0 通过，exit 4 拒绝并带回输出', async (t) => {
  const dir = tmpDir(t);
  const fake = path.join(dir, 'run.mjs');
  writeFileSync(fake, "process.stdout.write(JSON.stringify({ ok: true, note: 'fake' }) + '\\n');\nprocess.exit(Number(process.env.FAKE_EXIT || 0));\n");
  const ok = await runHighRiskAdapter({ runJs: fake, specDir: dir, repoDir: dir, verify: 'true', env: { FAKE_EXIT: '0' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.json?.note, 'fake');

  const bad = await runHighRiskAdapter({ runJs: fake, specDir: dir, repoDir: dir, verify: 'true', env: { FAKE_EXIT: '4' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 4);
  assert.match(bad.reason, /验收/);
});

test('runHighRiskAdapter：缺 spec 目录直接拒绝，不 spawn', async () => {
  const r = await runHighRiskAdapter({ runJs: 'nope.mjs', specDir: 'nope-dir', repoDir: '.', verify: 'true' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /找不到/);
});
