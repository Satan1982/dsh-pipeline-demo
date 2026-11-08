#!/usr/bin/env node
// ci/trust/verify.mjs —— v3 P1（docs/89 §3.1/§3.2）：witness 链的独立验签进程 + push 前断言。
//
// 分工：
//   - 签发（dispatch 侧）：appendWitness() 在「工作树干净」的提交点追加一条 witness，
//     prev_hash 接上一条，nonce 随机；stdout_sha256 绑定门禁输出，gate_bytes_sha256 绑定
//     被执行的 scripts/ci 字节（P0 的 overlay 快照）。
//   - 验签（本文件 CLI）：独立进程，不 import dispatch。land.sh 在 push 前调用，失败 exit 2
//     （docs/89 §3.1）。三条判据：①链完整（marker/hash/prev_hash/nonce 全对）
//     ②pushes 的 HEAD 必须被某条 witness 覆盖（commit + tree_after 双匹配，§3.2 L2）
//     ③仅文档/元数据改动可无 witness；门禁脚本自更新的第一次 push 走显式人工放行并留痕。
//
// 为什么 commit + tree 双匹配：commit 可被 amend/rebase 改写，tree_after 是内容哈希；
// 只比 commit 会漏掉「同一 commit 内容被换」的篡改，只比 tree 又会把不同提交混为一谈。
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateBytesSha256 } from '../gate-snapshot.mjs';
import { loadKeyring } from './keys.mjs';
import { MARKER, buildWitness, sha256, signWitness, verifyChain } from './witness.mjs';

export const CHAIN_BASENAME = 'witness.jsonl';
export const EXIT_OK = 0;
export const EXIT_FAIL = 2; // docs/89 §3.1：验签失败 exit 2
export const GATE_PREFIXES = ['ci/', 'scripts/', '.github/'];
export const META_PREFIXES = ['docs/', '.dshwolf/', '.logs/', 'dist/'];
export const META_FILES = new Set(['AGENTS.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md', '.gitignore', '.gitattributes']);

const GIT_BIN = process.env.DSH_GIT
  || (existsSync('C:/Program Files/Git/cmd/git.exe') ? 'C:/Program Files/Git/cmd/git.exe' : 'git');

export function defaultChainFile(repoDir) {
  return path.join(repoDir, '.logs', CHAIN_BASENAME);
}

function git(repoDir, args) {
  return execFileSync(GIT_BIN, ['-c', 'credential.helper=', ...args], {
    cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
  }).trim();
}

// JSONL 读回。坏行不算「跳过」——链的证据是一整排，少一行就是断链，必须整链失败。
export function readChain(file) {
  if (!file) return { ok: false, entries: [], error: '缺 chain 文件路径' };
  if (!existsSync(file)) return { ok: true, entries: [], missing: true };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, entries: [], error: `读不了 ${file}：${e.message}` };
  }
  const entries = [];
  for (const [i, line] of text.split('\n').entries()) {
    const s = line.trim();
    if (!s) continue;
    try {
      entries.push(JSON.parse(s));
    } catch (e) {
      return { ok: false, entries, error: `第 ${i + 1} 行不是 JSON（${e.message}）` };
    }
  }
  return { ok: true, entries };
}

// 追加一条 witness：prev_hash 取当前链尾，nonce 随机（同一秒并发也不会撞）。
// signer = { privateKey, keyId } 时加 ed25519 签名（docs/89 §六-1）；签名对象不含 sig，
// 所以 witness.hash 与 prev_hash 链接规则不变。
export function appendWitness(file, fields, { signer = null } = {}) {
  const list = readChain(file);
  if (!list.ok) throw new Error(`witness 链读不了，拒绝签发：${list.error}`);
  const prev = list.entries.length ? list.entries[list.entries.length - 1] : null;
  let w = buildWitness({
    ...fields,
    nonce: fields.nonce ?? randomUUID(),
    prev_hash: prev ? prev.hash : 'GENESIS',
    marker: fields.marker ?? MARKER,
  });
  if (signer) w = signWitness(w, signer);
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(w)}\n`);
  return w;
}

export function verifyChainFile(file, { keys = null, requireSignature = false } = {}) {
  const r = readChain(file);
  if (!r.ok) return { ok: false, n: 0, code: 'chain-unreadable', why: r.error };
  const v = verifyChain(r.entries, { keys, requireSignature });
  return { ...v, n: r.entries.length, entries: r.entries, missing: !!r.missing };
}

export function headIds(repoDir, ref = 'HEAD') {
  return {
    commit: git(repoDir, ['rev-parse', ref]),
    tree: git(repoDir, ['rev-parse', `${ref}^{tree}`]),
  };
}

// 覆盖判据（§3.2 L2）：合并树哈希 == 某条 witness 的 tree_after，且 commit 对得上。
export function findCover(entries, { commit, tree }) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const w = entries[i];
    if (w.commit === commit && w.tree_after === tree) return w;
  }
  return null;
}

export function isWorkingTreeClean(repoDir, ignorePrefixes = ['scripts', 'ci']) {
  // 只认「已跟踪文件的改动」：untracked 产物（dist/、.logs/ 等）由 .gitignore 管，
  // 不能因为它们存在就拒签——否则每个 agent 留下的草稿文件都会让证据永远签不出来。
  // 门禁目录默认不看：overlay 快照会在跑门禁时把 scripts/ci 写成 origin 的字节，
  // 那是验签器自己的工作区，不构成「待提交改动」。
  const pathspec = ['.', ...ignorePrefixes.map((p) => `:(exclude)${p}`)];
  return git(repoDir, ['status', '--porcelain', '--untracked-files=no', '--', ...pathspec]) === '';
}

// 私钥只由签名进程读；读不到就拒签（fail-closed），不会静默降级成无签名。
export function loadSigner(privateKeyPath, keyId = null) {
  if (!privateKeyPath) return null;
  const privateKey = readFileSync(privateKeyPath, 'utf8');
  return { privateKey, keyId: keyId || path.basename(privateKeyPath, '.pem') };
}

// 签发「本次提交 + 门禁执行」的证据。工作树不干净 → 拒签（fail-closed）。
// privateKeyPath 缺省不签名（旧哈希链 L2）；由 dispatch 用 DSH_WITNESS_KEY 打开。
export function attestCommit({
  repoDir, issue, stdout = '', gateBytes, chainFile = defaultChainFile(repoDir),
  privateKeyPath = process.env.DSH_WITNESS_KEY ?? null,
  keyId = process.env.DSH_WITNESS_KEY_ID ?? null,
}) {
  if (!isWorkingTreeClean(repoDir)) return { ok: false, why: '工作树不干净（已跟踪文件有改动），拒绝签发 witness' };
  let signer = null;
  if (privateKeyPath) {
    try {
      signer = loadSigner(privateKeyPath, keyId);
    } catch (e) {
      return { ok: false, why: `私钥读不了（${privateKeyPath}）：${e.message}` };
    }
  }
  let ids;
  try {
    ids = headIds(repoDir);
  } catch (e) {
    return { ok: false, why: `拿不到 HEAD 的 commit/tree：${e.message}` };
  }
  let gate = gateBytes;
  if (!gate) {
    try {
      gate = gateBytesSha256(repoDir).sha256;
    } catch (e) {
      return { ok: false, why: `算不出 gate_bytes_sha256：${e.message}` };
    }
  }
  const w = appendWitness(chainFile, {
    issue: String(issue ?? 'system'),
    commit: ids.commit,
    tree_after: ids.tree,
    stdout_sha256: sha256(stdout),
    gate_bytes_sha256: gate,
  }, { signer });
  return { ok: true, witness: w, chainFile, signed: !!signer };
}

export function assertHeadWitnessed({ repoDir, chainFile = defaultChainFile(repoDir), ref = 'HEAD', keyring = null }) {
  const chain = verifyChainFile(chainFile, { keys: keyring, requireSignature: !!keyring });
  if (!chain.ok) {
    return { ok: false, code: chain.code ?? 'chain-invalid', why: `witness 链无效：${chain.why}` };
  }
  let ids;
  try {
    ids = headIds(repoDir, ref);
  } catch (e) {
    return { ok: false, code: 'head-unreadable', why: `读不到 ${ref}：${e.message}` };
  }
  const hit = findCover(chain.entries, ids);
  if (!hit) {
    return {
      ok: false,
      code: 'unsigned-head',
      why: `${ref} ${ids.commit.slice(0, 8)}（tree ${ids.tree.slice(0, 8)}）没有对应的 witness —— push 前断言失败`,
      ids,
    };
  }
  return { ok: true, witness: hit, ids, n: chain.n };
}

// land.sh 判据：改了什么决定要不要 witness。纯函数，便于单测。
export function classifyPaths(changed) {
  const files = (changed ?? []).filter(Boolean);
  const isMeta = (p) => META_PREFIXES.some((x) => p.startsWith(x)) || META_FILES.has(p) || p.endsWith('.md');
  const isGate = (p) => GATE_PREFIXES.some((x) => p.startsWith(x));
  const code = files.filter((p) => !isMeta(p));
  const gate = code.filter(isGate);
  const source = code.filter((p) => !isGate(p));
  return { files, code, gate, source, gateOnly: code.length > 0 && source.length === 0 };
}

export function landChangedFiles(repoDir, base = 'origin/main') {
  return git(repoDir, ['diff', '--name-only', `${base}...HEAD`]).split('\n').map((s) => s.trim()).filter(Boolean);
}

function landCheck({ repoDir, chainFile, base, env, keyring = null }) {
  const chain = verifyChainFile(chainFile, { keys: keyring, requireSignature: !!keyring });
  if (!chain.ok) return { ok: false, why: `witness 链无效：${chain.why}` };
  let ids;
  try {
    ids = headIds(repoDir);
  } catch (e) {
    return { ok: false, why: `读不到 HEAD：${e.message}` };
  }
  const hit = findCover(chain.entries, ids);
  if (hit) return { ok: true, note: `HEAD 已被 witness 覆盖（${hit.hash.slice(0, 12)}）` };

  let changed;
  try {
    changed = landChangedFiles(repoDir, base);
  } catch (e) {
    return { ok: false, why: `拿不到 ${base}...HEAD 的改动（${e.message}）` };
  }
  const cls = classifyPaths(changed);
  if (cls.code.length === 0) return { ok: true, note: '仅文档/元数据改动，无需 witness' };
  if (cls.source.length > 0) {
    return { ok: false, why: `HEAD 未被 witness 覆盖，且改动了源文件：${cls.source.slice(0, 6).join(', ')}` };
  }
  // 门禁脚本自更新：push 验签的第一次落地必须能过，否则改验签器的提交永远推不上去。
  // 放行只对「全部改动都在 ci/ scripts/ .github/」生效，且必须显式设环境变量并留痕。
  if (cls.gateOnly && String(env.DSH_LAND_GATE_UPDATE ?? '') === '1') {
    const why = String(env.DSH_LAND_GATE_UPDATE_REASON ?? '门禁脚本自更新（人工放行）');
    const audit = path.join(repoDir, '.logs', 'gate-update-overrides.jsonl');
    mkdirSync(path.dirname(audit), { recursive: true });
    appendFileSync(audit, `${JSON.stringify({ at: new Date().toISOString(), head: ids.commit, tree: ids.tree, files: cls.gate, why })}\n`);
    return {
      ok: true,
      note: `门禁脚本自更新放行（DSH_LAND_GATE_UPDATE=1，理由：${why}）；已留痕 ${path.basename(audit)}`,
      warn: true,
    };
  }
  return {
    ok: false,
    why: [
      `HEAD ${ids.commit.slice(0, 8)} 未被 witness 覆盖，且改动了非文档文件：${cls.code.slice(0, 6).join(', ')}`,
      cls.gateOnly
        ? '如果这是门禁脚本自更新，设 DSH_LAND_GATE_UPDATE=1（会写 .logs/gate-update-overrides.jsonl）后重试。'
        : '源文件改动必须先在调度器 worktree 里过门禁并签发 witness 再 push。',
    ].join('\n'),
  };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { flags: new Set(), opts: new Map() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--chain' || a === '--repo' || a === '--land' || a === '--head' || a === '--keys') {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} 缺参数`);
      out.opts.set(a, v);
      i += 1;
    } else if (a.startsWith('--')) {
      out.flags.add(a);
    }
  }
  return out;
}

export function main(argv = process.argv.slice(2), env = process.env, log = console.log, errLog = console.error) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    errLog(`参数错误：${e.message}`);
    return EXIT_FAIL;
  }
  const repoDir = path.resolve(args.opts.get('--repo') ?? process.cwd());
  const chainFile = path.resolve(args.opts.get('--chain') ?? defaultChainFile(repoDir));
  const keyring = args.opts.has('--keys') ? loadKeyring(path.resolve(args.opts.get('--keys'))) : null;
  const chain = verifyChainFile(chainFile, { keys: keyring, requireSignature: !!keyring });
  if (!chain.ok) {
    errLog(`VERDICT: FAIL｜witness 链无效（${chain.code}）：${chain.why}`);
    errLog(`chain=${chainFile}`);
    return EXIT_FAIL;
  }
  log(`chain=${chainFile} n=${chain.n}${chain.missing ? '（文件不存在，视为空链）' : ''}${keyring ? ` keys=${keyring.size}（ed25519 验签）` : '（哈希链 L2，未启用 ed25519）'}`);

  if (args.opts.has('--land')) {
    const r = landCheck({ repoDir, chainFile, base: args.opts.get('--land'), env, keyring });
    if (!r.ok) {
      errLog(`VERDICT: FAIL｜${r.why}`);
      return EXIT_FAIL;
    }
    if (r.warn) errLog(`⚠ ${r.note}`);
    else log(`✓ ${r.note}`);
    log('VERDICT: PASS');
    return EXIT_OK;
  }

  if (args.opts.has('--head')) {
    const ref = args.opts.get('--head') || 'HEAD';
    const r = assertHeadWitnessed({ repoDir, chainFile, ref, keyring });
    if (!r.ok) {
      errLog(`VERDICT: FAIL｜${r.why}`);
      return EXIT_FAIL;
    }
    log(`✓ ${ref} 已被 witness 覆盖（${r.witness.hash.slice(0, 12)}）`);
    log('VERDICT: PASS');
    return EXIT_OK;
  }

  log(`✓ ${chain.why}`);
  log('VERDICT: PASS');
  return EXIT_OK;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
