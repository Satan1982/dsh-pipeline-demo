import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { genKeypair, revokeKey, loadKeyring, readRevocations } from './trust/keys.mjs';
import { signWitness, verifyWitness, verifyChain, buildWitness } from './trust/witness.mjs';

// v3 P1 补（docs/89 §六-1）：密钥生成 / 撤销 / 签名验签的最小回归。
function tmpDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-keys-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function witness(i, prev) {
  return buildWitness({
    issue: String(100 + i),
    commit: `c${i}`.padEnd(40, '0'),
    tree_after: `t${i}`.padEnd(40, '0'),
    stdout_sha256: 'a'.repeat(64),
    gate_bytes_sha256: 'b'.repeat(64),
    nonce: `nonce-${i}`,
    prev_hash: prev ? prev.hash : 'GENESIS',
  });
}

test('gen 生成公钥/私钥/元数据，loadKeyring 能读回', (t) => {
  const dir = tmpDir(t);
  const { privPath, pubPath, meta } = genKeypair({ keysDir: dir, keyId: 'k1', notAfter: '2027-11-08' });
  const keys = loadKeyring(dir);
  assert.equal(keys.size, 1);
  assert.ok(keys.get('k1'));
  assert.equal(meta.fingerprint.length, 32);
  assert.ok(readFileSync(privPath, 'utf8').includes('PRIVATE KEY'));
  assert.ok(readFileSync(pubPath, 'utf8').includes('PUBLIC KEY'));
});

test('同 id 重复生成拒绝覆盖', (t) => {
  const dir = tmpDir(t);
  genKeypair({ keysDir: dir, keyId: 'k1' });
  assert.throws(() => genKeypair({ keysDir: dir, keyId: 'k1' }), /已存在/);
});

test('撤销写账本且 loadKeyring.revoked 生效', (t) => {
  const dir = tmpDir(t);
  genKeypair({ keysDir: dir, keyId: 'k1' });
  const rec = revokeKey({ keysDir: dir, keyId: 'k1', reason: '私钥泄露' });
  assert.equal(rec.key_id, 'k1');
  assert.equal(readRevocations(dir).length, 1);
  assert.ok(loadKeyring(dir).revoked.has('k1'));
});

test('签名 witness 通过；缺签名/篡改/撤销都拒', (t) => {
  const dir = tmpDir(t);
  const { privPath } = genKeypair({ keysDir: dir, keyId: 'k1' });
  const priv = readFileSync(privPath, 'utf8');
  const keys = loadKeyring(dir);
  const w = witness(0);
  const signed = signWitness(w, { privateKey: priv, keyId: 'k1' });

  assert.equal(verifyWitness(signed, { publicKey: keys.get('k1'), requireSignature: true }).ok, true);
  assert.equal(verifyWitness(w, { publicKey: keys.get('k1'), requireSignature: true }).code, 'unsigned-witness');

  const tampered = { ...signed, stdout_sha256: 'c'.repeat(64) };
  assert.equal(verifyWitness(tampered, { publicKey: keys.get('k1'), requireSignature: true }).code, 'hash-mismatch');
  const badSig = { ...signed, sig: Buffer.alloc(64, 1).toString('base64') };
  assert.equal(verifyWitness(badSig, { publicKey: keys.get('k1'), requireSignature: true }).code, 'sig-invalid');

  revokeKey({ keysDir: dir, keyId: 'k1', reason: 'leak' });
  const after = loadKeyring(dir);
  assert.equal(verifyWitness(signed, { publicKey: after.get('k1'), revokedKeys: after.revoked, requireSignature: true }).code, 'key-revoked');
});

test('verifyChain 带签名两环通过，requireSignature 下未签名链拒', (t) => {
  const dir = tmpDir(t);
  const { privPath } = genKeypair({ keysDir: dir, keyId: 'k1' });
  const priv = readFileSync(privPath, 'utf8');
  const keys = loadKeyring(dir);
  const w1 = signWitness(witness(0), { privateKey: priv, keyId: 'k1' });
  const w2 = signWitness(witness(1, w1), { privateKey: priv, keyId: 'k1' });

  assert.equal(verifyChain([w1, w2], { keys, requireSignature: true }).ok, true);
  assert.equal(verifyChain([witness(0)], { keys, requireSignature: true }).code, 'unsigned-witness');
});
