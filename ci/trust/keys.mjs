#!/usr/bin/env node
// ci/trust/keys.mjs —— v3 P1 补（docs/89 §3.1/§六-1）：ed25519 密钥生成、撤销清单与公钥加载。
//
// 分工：
//   - 私钥只在签名进程（dispatch）里；本工具只在「生成/撤销/查看」时碰它，不打印内容。
//   - 公钥人签入 governance/keys/（`<keyId>.pub.pem`），随仓库分发；验签只用公钥。
//   - 撤销清单 `revoked.jsonl` 与公钥同目录：被撤销 key 签的 witness 一律作废，
//     重签历史用新 key 重新签同一条 tree（见 ci/drills/revoke.mjs 演练）。
//
// 用法：
//   node ci/trust/keys.mjs gen --dir governance/keys --id dispatch-20261108 [--not-after 2027-11-08]
//   node ci/trust/keys.mjs revoke --dir governance/keys --id dispatch-20261108 --reason 私钥泄露 [--replaced-by dispatch-20261109]
//   node ci/trust/keys.mjs list --dir governance/keys
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEYS_META = 'keys.jsonl';
export const REVOKED_FILE = 'revoked.jsonl';

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function fingerprintOf(publicKeyPem) {
  return sha256(publicKeyPem).slice(0, 32);
}

function appendJsonl(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const sep = prev && !prev.endsWith('\n') ? '\n' : '';
  writeFileSync(file, `${prev}${sep}${JSON.stringify(obj)}\n`, 'utf8');
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function readKeys(keysDir) {
  return readJsonl(path.join(keysDir, KEYS_META));
}

export function readRevocations(keysDir) {
  return readJsonl(path.join(keysDir, REVOKED_FILE));
}

// 生成一对 ed25519 密钥；私钥 0600，公钥可分发。同 id 已存在 → 拒绝覆盖（密钥一旦覆盖，
// 历史签名的可验性就没了）。
export function genKeypair({ keysDir, keyId, notAfter = null, now = new Date() }) {
  if (!keyId || !/^[A-Za-z0-9._-]+$/.test(keyId)) throw new Error(`非法 key id：${keyId}`);
  mkdirSync(keysDir, { recursive: true });
  const privPath = path.join(keysDir, `${keyId}.pem`);
  const pubPath = path.join(keysDir, `${keyId}.pub.pem`);
  if (existsSync(privPath) || existsSync(pubPath)) throw new Error(`key ${keyId} 已存在，拒绝覆盖`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(privPath, privateKey, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(pubPath, publicKey, 'utf8');
  const meta = {
    key_id: keyId,
    fingerprint: fingerprintOf(publicKey),
    created: now.toISOString(),
    not_after: notAfter,
    algo: 'ed25519',
  };
  appendJsonl(path.join(keysDir, KEYS_META), meta);
  return { meta, privPath, pubPath };
}

// 撤销一个 key：只写账本，不删文件（删了就没法解释历史签名）。
export function revokeKey({ keysDir, keyId, reason, replacedBy = null, by = 'unknown', now = new Date() }) {
  if (!keyId) throw new Error('revoke 需要 --id');
  const meta = readKeys(keysDir).find((k) => k.key_id === keyId);
  const pubPath = path.join(keysDir, `${keyId}.pub.pem`);
  const fingerprint = meta?.fingerprint ?? (existsSync(pubPath) ? fingerprintOf(readFileSync(pubPath, 'utf8')) : null);
  const rec = {
    at: now.toISOString(),
    key_id: keyId,
    fingerprint,
    reason: reason || '（未填理由）',
    replaced_by: replacedBy,
    by,
  };
  appendJsonl(path.join(keysDir, REVOKED_FILE), rec);
  return rec;
}

// 加载验签所需的公钥表与撤销集。返回的对象直接喂 verifyChain({ keys })。
export function loadKeyring(keysDir) {
  const map = new Map();
  if (keysDir && existsSync(keysDir)) {
    for (const name of readdirSync(keysDir)) {
      if (!name.endsWith('.pub.pem')) continue;
      const keyId = name.slice(0, -'.pub.pem'.length);
      map.set(keyId, createPublicKey(readFileSync(path.join(keysDir, name), 'utf8')));
    }
  }
  const revoked = new Set(readRevocations(keysDir).map((r) => r.key_id));
  map.revoked = revoked;
  return map;
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { opts: new Map(), flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--')) { out.opts.set(a, v); i += 1; } else out.flags.add(a);
    }
  }
  return out;
}

export function main(argv = process.argv.slice(2), env = process.env, log = console.log, errLog = console.error) {
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const dir = path.resolve(args.opts.get('--dir') ?? 'governance/keys');
  const by = env.DSH_KEY_ACTOR || env.USERNAME || 'unknown';
  try {
    if (cmd === 'gen') {
      const r = genKeypair({
        keysDir: dir,
        keyId: args.opts.get('--id'),
        notAfter: args.opts.get('--not-after') ?? null,
      });
      log(`✓ 生成 ${r.meta.key_id}（fingerprint ${r.meta.fingerprint}）`);
      log(`  私钥 ${r.privPath}（0600，勿提交）`);
      log(`  公钥 ${r.pubPath}（随仓库分发）`);
      return 0;
    }
    if (cmd === 'revoke') {
      const r = revokeKey({
        keysDir: dir,
        keyId: args.opts.get('--id'),
        reason: args.opts.get('--reason'),
        replacedBy: args.opts.get('--replaced-by') ?? null,
        by,
      });
      log(`✓ 已撤销 ${r.key_id}（fingerprint ${r.fingerprint ?? 'unknown'}，理由：${r.reason}${r.replaced_by ? `，替代 ${r.replaced_by}` : ''}）`);
      log(`  账本 ${path.join(dir, REVOKED_FILE)}`);
      return 0;
    }
    if (cmd === 'list') {
      const keys = readKeys(dir);
      const revoked = new Set(readRevocations(dir).map((r) => r.key_id));
      if (keys.length === 0) { log(`（${dir} 没有密钥）`); return 0; }
      for (const k of keys) {
        log(`${revoked.has(k.key_id) ? '✗ 已撤销' : '✓ 有效'}  ${k.key_id}  fp=${k.fingerprint}  not_after=${k.not_after ?? '-'}`);
      }
      return 0;
    }
    errLog('用法: keys.mjs <gen|revoke|list> --dir <keys> ...');
    return 2;
  } catch (e) {
    errLog(`错误：${e.message}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
