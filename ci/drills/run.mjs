#!/usr/bin/env node
// ci/drills/run.mjs —— v3 P0 验收：四负例必红，全红才 exit 0（docs/89 §3.2）。
// 另加一条正对照：未被篡改的 witness 必须被接受——否则「全拒」也能过，等于没测。
import assert from 'node:assert/strict';
import { buildWitness, verifyWitness, verifyChain, MARKER, sha256 } from '../trust/witness.mjs';

const base = {
  issue: 42,
  commit: 'a'.repeat(40),
  tree_after: sha256('tree'),
  stdout_sha256: sha256('stdout: ok'),
  gate_bytes_sha256: sha256('gate'),
  nonce: 'n-1',
  prev_hash: 'GENESIS',
};

const cases = [];

// 正对照：干净 witness 必须通过（防「验证器一律拒」的假绿）。
cases.push(['positive-control', () => {
  const w = buildWitness(base);
  const r = verifyWitness(w);
  assert.equal(r.ok, true, `正对照应通过，实际 ${r.code}`);
  return r;
}]);

// 负例 1：伪造 marker。
cases.push(['forged-marker', () => {
  const w = buildWitness({ ...base, marker: 'WITNESS' });
  const r = verifyWitness(w);
  assert.equal(r.ok, false, '伪造 marker 竟然通过');
  assert.equal(r.code, 'marker-invalid');
  return r;
}]);

// 负例 2：改 stdout 哈希（记录与正文不一致）。
cases.push(['stdout-hash-tamper', () => {
  const w = buildWitness(base);
  const r = verifyWitness(w, { actualStdout: 'stdout: evil' });
  assert.equal(r.ok, false, 'stdout 被改仍通过');
  assert.equal(r.code, 'stdout-mismatch');
  return r;
}]);

// 负例 3：断链（第二条的 prev_hash 指向别处）。
cases.push(['broken-chain', () => {
  const w1 = buildWitness(base);
  const w2 = buildWitness({ ...base, nonce: 'n-2', prev_hash: sha256('not-the-first') });
  const r = verifyChain([w1, w2]);
  assert.equal(r.ok, false, '断链竟然通过');
  assert.equal(r.code, 'chain-broken');
  return r;
}]);

// 负例 4：旧 nonce 重放。
cases.push(['nonce-replay', () => {
  const w1 = buildWitness(base);
  const w2 = buildWitness({ ...base, prev_hash: w1.hash });
  const r = verifyChain([w1, w2]);
  assert.equal(r.ok, false, '重放竟然通过');
  assert.equal(r.code, 'nonce-replay');
  return r;
}]);

let failed = 0;
for (const [name, fn] of cases) {
  try {
    const r = fn();
    console.log(`${r.ok ? 'PASS' : 'REJECT'} ${name}: ${r.code} — ${r.why}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}: ${e.message}`);
    if (e.expected !== undefined) console.log(`  expected=${JSON.stringify(e.expected)} actual=${JSON.stringify(e.actual)}`);
  }
}
if (failed) {
  console.log(`\n${failed}/${cases.length} 例没被判红`);
  console.log('VERDICT: FAIL 负例未全红');
  process.exit(1);
}
console.log(`\n${cases.length}/${cases.length} 判红（1 正对照 + 4 负例）`);
console.log(`VERDICT: PASS`);
void MARKER;
