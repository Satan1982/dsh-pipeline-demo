#!/usr/bin/env node
// ci/trust/witness.mjs —— v3 P0（docs/89 §3.1/§3.2）：witness 七元组 + gate_bytes_sha256 的最小可信链。
//
// 只做「可机械判定」的部分：字段齐全、marker 正确、stdout 哈希对得上、prev_hash 连得上、
// nonce 不重复。判不了的一律拒（fail-closed）。drills 是它的负例集（ci/drills/run.mjs）。
import { createHash } from 'node:crypto';

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

// 单条校验：返回 { ok, code, why }。code 给 drills 断言用。
export function verifyWitness(w, { prev = null, seenNonces = new Set(), actualStdout = null } = {}) {
  if (!w || typeof w !== 'object') return { ok: false, code: 'no-witness', why: '缺 witness' };
  for (const f of FIELDS) {
    if (!w[f]) return { ok: false, code: `missing-${f}`, why: `缺字段 ${f}` };
  }
  if (w.marker !== MARKER) return { ok: false, code: 'marker-invalid', why: `marker 非 ${MARKER}（伪造）` };
  if (w.hash !== witnessHash(w)) return { ok: false, code: 'hash-mismatch', why: 'witness 字节被改过' };
  if (actualStdout !== null && sha256(actualStdout) !== w.stdout_sha256) {
    return { ok: false, code: 'stdout-mismatch', why: 'stdout 哈希对不上（改 stdout 或改记录）' };
  }
  if (prev ? w.prev_hash !== prev.hash : w.prev_hash !== 'GENESIS') {
    return { ok: false, code: 'chain-broken', why: `prev_hash 连不上（期望 ${prev ? prev.hash.slice(0, 8) : 'GENESIS'}）` };
  }
  if (seenNonces.has(w.nonce)) return { ok: false, code: 'nonce-replay', why: `nonce 重复：${w.nonce}` };
  return { ok: true, code: 'ok', why: 'witness 合法' };
}

// 链式校验：任一环失败即整链失败（并把失败 code 带回去）。
export function verifyChain(list) {
  const seen = new Set();
  let prev = null;
  for (const [i, w] of list.entries()) {
    const r = verifyWitness(w, { prev, seenNonces: seen });
    if (!r.ok) return { ok: false, at: i, code: r.code, why: r.why };
    seen.add(w.nonce);
    prev = w;
  }
  return { ok: true, code: 'ok', why: `链完整（n=${list.length}）` };
}
