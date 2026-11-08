#!/usr/bin/env node
// ci/trust/witness.mjs —— v3 P0（docs/89 §3.1/§3.2）：witness 七元组 + gate_bytes_sha256 的最小可信链。
//
// 只做「可机械判定」的部分：字段齐全、marker 正确、stdout 哈希对得上、prev_hash 连得上、
// nonce 不重复。判不了的一律拒（fail-closed）。drills 是它的负例集（ci/drills/run.mjs）。
import { createHash, sign, verify } from 'node:crypto';

export const MARKER = 'DSH-WITNESS-V1';
export const FIELDS = [
  'issue', 'commit', 'tree_after', 'stdout_sha256',
  'gate_bytes_sha256', 'nonce', 'prev_hash', 'marker',
];

export function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

export function witnessHash(w) {
  return sha256(FIELDS.map((f) => `${f}=${w[f] ?? ''}`).join('\n'));
}

export function buildWitness(fields) {
  const w = { ...fields, marker: fields.marker ?? MARKER };
  w.hash = witnessHash(w);
  return w;
}

// ed25519 签名（v3 P1 补：docs/89 §3.1）。签名对象是 witnessHash（不含 sig/key_id），
// 所以哈希链的旧条目仍可校验；带签名的条目多了「谁签的、有没有被撤销」。
// 私钥只在签名进程里；本函数收 PEM 文本，不落盘、不进日志。
export function signWitness(w, { privateKey, keyId }) {
  if (!privateKey || !keyId) throw new Error('signWitness 需要 privateKey 与 keyId');
  const sig = sign(null, Buffer.from(witnessHash(w), 'utf8'), privateKey).toString('base64');
  return { ...w, key_id: keyId, sig };
}

// 单条校验：返回 { ok, code, why }。code 给 drills 断言用。
export function verifyWitness(w, {
  prev = null, seenNonces = new Set(), actualStdout = null,
  publicKey = null, revokedKeys = null, requireSignature = false,
} = {}) {
  if (!w || typeof w !== 'object') return { ok: false, code: 'no-witness', why: '缺 witness' };
  for (const f of FIELDS) {
    if (!w[f]) return { ok: false, code: `missing-${f}`, why: `缺字段 ${f}` };
  }
  if (w.marker !== MARKER) return { ok: false, code: 'marker-invalid', why: `marker 非 ${MARKER}（伪造）` };
  if (w.hash !== witnessHash(w)) return { ok: false, code: 'hash-mismatch', why: 'witness 字节被改过' };
  if (actualStdout !== null && sha256(actualStdout) !== w.stdout_sha256) {
    return { ok: false, code: 'stdout-mismatch', why: 'stdout 哈希对不上（改 stdout 或改记录）' };
  }
  // 撤销是全局否决：被撤销 key 签的证据一律作废，哪怕签名本身有效。
  if (revokedKeys && w.key_id && revokedKeys.has(w.key_id)) {
    return { ok: false, code: 'key-revoked', why: `key ${w.key_id} 已撤销，其签名证据作废` };
  }
  if (requireSignature) {
    if (!w.sig || !w.key_id) return { ok: false, code: 'unsigned-witness', why: '缺 ed25519 签名（requireSignature）' };
    if (!publicKey) return { ok: false, code: 'unknown-key', why: `没有 key ${w.key_id} 的公钥` };
    const ok = verify(null, Buffer.from(witnessHash(w), 'utf8'), publicKey, Buffer.from(w.sig, 'base64'));
    if (!ok) return { ok: false, code: 'sig-invalid', why: `key ${w.key_id} 的签名对不上` };
  }
  if (prev ? w.prev_hash !== prev.hash : w.prev_hash !== 'GENESIS') {
    return { ok: false, code: 'chain-broken', why: `prev_hash 连不上（期望 ${prev ? prev.hash.slice(0, 8) : 'GENESIS'}）` };
  }
  if (seenNonces.has(w.nonce)) return { ok: false, code: 'nonce-replay', why: `nonce 重复：${w.nonce}` };
  return { ok: true, code: 'ok', why: 'witness 合法' };
}

// 链式校验：任一环失败即整链失败（并把失败 code 带回去）。
// keys：{ get(keyId) => KeyObject|null, revoked: Set<keyId> }，由 verify.mjs 从
// governance/keys 加载；不传则保持哈希链（L2）语义。
export function verifyChain(list, { keys = null, requireSignature = false } = {}) {
  const seen = new Set();
  let prev = null;
  for (const [i, w] of list.entries()) {
    const publicKey = keys && w.key_id ? keys.get(w.key_id) : null;
    const r = verifyWitness(w, {
      prev, seenNonces: seen,
      publicKey, revokedKeys: keys ? keys.revoked : null, requireSignature,
    });
    if (!r.ok) return { ok: false, at: i, code: r.code, why: r.why };
    seen.add(w.nonce);
    prev = w;
  }
  return { ok: true, code: 'ok', why: `链完整（n=${list.length}）` };
}
