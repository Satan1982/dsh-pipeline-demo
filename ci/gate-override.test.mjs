import test from 'node:test';
import assert from 'node:assert/strict';

import { overrideDecision, gateFilesFromFindings, overrideRecord, overrideLogFile } from './gate-override.mjs';

test('没开 DSH_ALLOW_GATE 时不算放行', () => {
  const d = overrideDecision({});
  assert.equal(d.on, false);
  assert.equal(d.ok, false);
});

test('开了但没有理由：拒绝放行（并要求写理由）', () => {
  const d = overrideDecision({ DSH_ALLOW_GATE: '1' });
  assert.equal(d.on, true);
  assert.equal(d.ok, false);
  assert.match(d.error, /DSH_ALLOW_GATE_REASON/);
});

test('开了且带理由：放行并带回理由', () => {
  const d = overrideDecision({ DSH_ALLOW_GATE: '1', DSH_ALLOW_GATE_REASON: '  修 CI 脚本  ' });
  assert.equal(d.ok, true);
  assert.equal(d.reason, '修 CI 脚本');
});

test('只取被放行的门禁改动文件（去重、保序）', () => {
  const files = gateFilesFromFindings([
    { rule: 'gate-modified', severity: 'warn', file: 'scripts/verify.sh' },
    { rule: 'big-diff', severity: 'warn', file: 'src/x.js' },
    { rule: 'gate-modified', severity: 'warn', file: 'ci/dispatch.mjs' },
    { rule: 'gate-modified', severity: 'warn', file: 'scripts/verify.sh' },
    { rule: 'gate-modified' },
  ]);
  assert.deepEqual(files, ['scripts/verify.sh', 'ci/dispatch.mjs']);
});

test('留痕记录字段稳定，日志路径可被环境变量覆盖', () => {
  const rec = overrideRecord({ reason: '临时修门禁', files: ['ci/x.mjs'], repo: 'D:/code/p', head: 'abc1234' });
  assert.equal(rec.kind, 'gate-override');
  assert.equal(rec.reason, '临时修门禁');
  assert.deepEqual(rec.files, ['ci/x.mjs']);
  assert.match(rec.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(overrideLogFile(), /gate-override\.jsonl$/);
});
