#!/usr/bin/env node
// ci/drills/revoke.mjs —— v3 P1 补（docs/89 §六-1）：私钥泄露后的作废 + 重签演练。
//
// 演练前提是 witness 已用 ed25519 签名（ci/trust/witness.mjs signWitness）。
// 四步必须全绿：
//   ① keyA 签的证据通过；
//   ② 撤销 keyA 后同一份证据被拒（code=key-revoked）；
//   ③ keyB 重签同一条 merge tree 后通过（重签历史）；
//   ④ 撤销账本记录 keyA、理由与替代 key。
// 只在临时目录里生成密钥，不碰真实 .secrets，也不写仓库内任何文件。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genKeypair, loadKeyring, readRevocations, revokeKey } from '../trust/keys.mjs';
import { appendWitness, verifyChainFile } from '../trust/verify.mjs';
import { sha256 } from '../trust/witness.mjs';

const fields = {
  issue: 'drill-42',
  commit: 'a'.repeat(40),
  tree_after: sha256('merge-tree-after'),
  stdout_sha256: sha256('VERDICT: PASS'),
  gate_bytes_sha256: sha256('gate-bytes'),
};

export function runDrill({ log = console.log } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'revoke-drill-'));
  try {
    const a = genKeypair({ keysDir: dir, keyId: 'key-a' });
    genKeypair({ keysDir: dir, keyId: 'key-b' });

    const chainA = path.join(dir, 'witness-a.jsonl');
    const wa = appendWitness(chainA, fields, {
      signer: { privateKey: readFileSync(a.privPath, 'utf8'), keyId: 'key-a' },
    });
    const okA = verifyChainFile(chainA, { keys: loadKeyring(dir), requireSignature: true });
    assert.equal(okA.ok, true, `① A 签名应通过：${okA.code} ${okA.why}`);

    revokeKey({ keysDir: dir, keyId: 'key-a', reason: '私钥泄露演练', replacedBy: 'key-b', by: 'drill' });
    const refused = verifyChainFile(chainA, { keys: loadKeyring(dir), requireSignature: true });
    assert.equal(refused.ok, false, '② 撤销后 A 的证据必须作废');
    assert.equal(refused.code, 'key-revoked', `② 期望 key-revoked，实际 ${refused.code}`);

    const chainB = path.join(dir, 'witness-b.jsonl');
    const wb = appendWitness(chainB, fields, {
      signer: { privateKey: readFileSync(path.join(dir, 'key-b.pem'), 'utf8'), keyId: 'key-b' },
    });
    const okB = verifyChainFile(chainB, { keys: loadKeyring(dir), requireSignature: true });
    assert.equal(okB.ok, true, `③ B 重签后应通过：${okB.code} ${okB.why}`);
    assert.equal(wb.tree_after, wa.tree_after, '③ 重签必须指向同一条 merge tree');
    assert.notEqual(wb.nonce, wa.nonce, '③ 重签必须换新 nonce');

    const ledger = readRevocations(dir);
    assert.equal(ledger.length, 1, '④ 撤销账本应有一条记录');
    assert.equal(ledger[0].key_id, 'key-a');
    assert.equal(ledger[0].replaced_by, 'key-b');

    log('REVOKE-DRILL: PASS');
    log(`  A 签名通过 → 撤销 A 后 ${refused.code} → B 重签同一 tree（${wb.tree_after.slice(0, 12)}）通过`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = runDrill();
  } catch (e) {
    console.error(`REVOKE-DRILL: FAIL｜${e.message}`);
    process.exitCode = 1;
  }
}
