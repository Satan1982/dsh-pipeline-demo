// ci/trust-verify.test.mjs —— v3 P1（docs/89 §3.1/§3.2）：witness 链 + push 前断言 + land 判据。
// 放在 ci/ 顶层：verify.sh 的测试清单只 glob `ci/*.test.mjs`。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXIT_FAIL,
  EXIT_OK,
  appendWitness,
  assertHeadWitnessed,
  attestCommit,
  classifyPaths,
  isWorkingTreeClean,
  main,
  readChain,
  verifyChainFile,
} from './trust/verify.mjs';

const GIT = process.env.DSH_GIT
  || (existsSync('C:/Program Files/Git/cmd/git.exe') ? 'C:/Program Files/Git/cmd/git.exe' : 'git');

function g(cwd, args) {
  return execFileSync(GIT, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// 最小可提交仓库：一个 docs 文件 + 一个 src 文件，一次初始提交。
function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'witness-repo-'));
  g(dir, ['init', '-q']);
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'docs', 'a.md'), '# a\n');
  writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

function chainOf(dir) {
  return path.join(dir, '.logs', 'witness.jsonl');
}

test('classifyPaths：文档可免签名，门禁与源码要分开判定', () => {
  const meta = classifyPaths(['docs/a.md', 'AGENTS.md', '.dshwolf/x.json', 'dist/out.js']);
  assert.equal(meta.code.length, 0);
  assert.equal(meta.gateOnly, false);

  const gate = classifyPaths(['ci/dispatch.mjs', 'scripts/verify.sh']);
  assert.equal(gate.gateOnly, true);
  assert.equal(gate.source.length, 0);

  const mixed = classifyPaths(['ci/x.mjs', 'src/y.js']);
  assert.equal(mixed.gateOnly, false);
  assert.deepEqual(mixed.source, ['src/y.js']);
  assert.deepEqual(mixed.gate, ['ci/x.mjs']);
});

test('readChain：缺失=空链，坏行=整链失败（不跳过）', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'witness-read-'));
  try {
    const missing = readChain(path.join(dir, 'nope.jsonl'));
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.entries, []);
    assert.equal(missing.missing, true);

    const file = path.join(dir, 'bad.jsonl');
    writeFileSync(file, '{"a":1}\nnot-json\n');
    const bad = readChain(file);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /不是 JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('witness 链：prev_hash 接链尾，verifyChainFile 认整链', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'witness-chain-'));
  try {
    const file = path.join(dir, 'w.jsonl');
    const w1 = appendWitness(file, { issue: '1', commit: 'c'.repeat(40), tree_after: 't'.repeat(40), stdout_sha256: 's'.repeat(64), gate_bytes_sha256: 'g'.repeat(64) });
    const w2 = appendWitness(file, { issue: '2', commit: 'd'.repeat(40), tree_after: 'u'.repeat(40), stdout_sha256: 's'.repeat(64), gate_bytes_sha256: 'g'.repeat(64) });
    assert.equal(w1.prev_hash, 'GENESIS');
    assert.equal(w2.prev_hash, w1.hash);
    assert.notEqual(w1.nonce, w2.nonce);
    assert.equal(w1.marker, 'DSH-WITNESS-V1');
    const ok = verifyChainFile(file);
    assert.equal(ok.ok, true);
    assert.equal(ok.n, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('篡改链：改一行内容而不重算 hash → 整链失败', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'witness-tamper-'));
  try {
    const file = path.join(dir, 'w.jsonl');
    appendWitness(file, { issue: '1', commit: 'c'.repeat(40), tree_after: 't'.repeat(40), stdout_sha256: 's'.repeat(64), gate_bytes_sha256: 'g'.repeat(64) });
    appendWitness(file, { issue: '2', commit: 'd'.repeat(40), tree_after: 'u'.repeat(40), stdout_sha256: 's'.repeat(64), gate_bytes_sha256: 'g'.repeat(64) });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    lines[1].tree_after = 'X'.repeat(40);
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const bad = verifyChainFile(file);
    assert.equal(bad.ok, false);
    assert.match(String(bad.code ?? bad.why), /hash|链/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nonce 复用（重放）被链校验拒绝', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'witness-nonce-'));
  try {
    const file = path.join(dir, 'w.jsonl');
    appendWitness(file, { issue: '1', commit: 'c'.repeat(40), tree_after: 't'.repeat(40), stdout_sha256: 's'.repeat(64), gate_bytes_sha256: 'g'.repeat(64), nonce: 'same-nonce' });
    appendWitness(file, { issue: '2', commit: 'd'.repeat(40), tree_after: 'u'.repeat(40), stdout_sha256: 's'.repeat(64), gate_bytes_sha256: 'g'.repeat(64), nonce: 'same-nonce' });
    const bad = verifyChainFile(file);
    assert.equal(bad.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attestCommit：干净提交签出证据，脏工作树拒签；改 HEAD 后断言失败', () => {
  const dir = makeRepo();
  try {
    const file = chainOf(dir);
    const gateBytes = 'g'.repeat(64);
    const att = attestCommit({ repoDir: dir, issue: 'issue-7', stdout: 'VERDICT: PASS\n', gateBytes, chainFile: file });
    assert.equal(att.ok, true);
    assert.equal(att.witness.commit, g(dir, ['rev-parse', 'HEAD']));
    assert.equal(att.witness.tree_after, g(dir, ['rev-parse', 'HEAD^{tree}']));
    assert.equal(att.witness.gate_bytes_sha256, gateBytes);

    const covered = assertHeadWitnessed({ repoDir: dir, chainFile: file });
    assert.equal(covered.ok, true);

    // 已跟踪文件脏 → 拒签（fail-closed）。
    writeFileSync(path.join(dir, 'src', 'a.js'), 'export const a = 2;\n');
    assert.equal(isWorkingTreeClean(dir), false);
    const dirty = attestCommit({ repoDir: dir, issue: '8', stdout: '', gateBytes, chainFile: file });
    assert.equal(dirty.ok, false);
    assert.match(dirty.why, /工作树不干净/);

    // untracked 不算脏（agent 留下的草稿不影响证据）。
    g(dir, ['checkout', '--', 'src/a.js']);
    writeFileSync(path.join(dir, 'src', 'draft.js'), 'draft\n');
    assert.equal(isWorkingTreeClean(dir), true);

    // HEAD 变了而链里没有新证据 → push 前断言必须失败。
    g(dir, ['add', 'src/draft.js']);
    g(dir, ['commit', '-q', '-m', 'next']);
    const unsigned = assertHeadWitnessed({ repoDir: dir, chainFile: file });
    assert.equal(unsigned.ok, false);
    assert.equal(unsigned.code, 'unsigned-head');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main --land：文档改动免验签，源码改动拒推（exit 2）', () => {
  const dir = makeRepo();
  try {
    const file = chainOf(dir);
    const base = g(dir, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(dir, 'docs', 'b.md'), '# b\n');
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'docs']);

    const logs = [];
    const docsRun = main(['--chain', file, '--repo', dir, '--land', base], {}, (m) => logs.push(m), (m) => logs.push(m));
    assert.equal(docsRun, EXIT_OK);
    assert.match(logs.join('\n'), /无需 witness/);

    writeFileSync(path.join(dir, 'src', 'b.js'), 'export const b = 2;\n');
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'code']);
    const codeRun = main(['--chain', file, '--repo', dir, '--land', base], {}, () => {}, () => {});
    assert.equal(codeRun, EXIT_FAIL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main --land：门禁脚本自更新需显式放行，且写审计留痕', () => {
  const dir = makeRepo();
  try {
    const file = chainOf(dir);
    const base = g(dir, ['rev-parse', 'HEAD']);
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'scripts', 'verify.sh'), '#!/usr/bin/env bash\n');
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'gate']);

    const denied = main(['--chain', file, '--repo', dir, '--land', base], {}, () => {}, () => {});
    assert.equal(denied, EXIT_FAIL);

    const allowed = main(['--chain', file, '--repo', dir, '--land', base], { DSH_LAND_GATE_UPDATE: '1' }, () => {}, () => {});
    assert.equal(allowed, EXIT_OK);
    const audit = path.join(dir, '.logs', 'gate-update-overrides.jsonl');
    assert.equal(existsSync(audit), true);
    assert.match(readFileSync(audit, 'utf8'), /scripts\/verify\.sh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main --mirror：自 Gitee 基线起仅文档改动放行，源码改动拒推（与 --land 同判据）', () => {
  const dir = makeRepo();
  try {
    const file = chainOf(dir);
    const base = g(dir, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(dir, 'docs', 'b.md'), '# b\n');
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'docs']);
    const ref = 'refs/remotes/origin/main'; // mirror-gitee.sh 的 SRC 就是这么传的
    g(dir, ['update-ref', ref, 'HEAD']);

    const logs = [];
    const docsRun = main(['--chain', file, '--repo', dir, '--mirror', ref, '--base', base], {}, (m) => logs.push(m), (m) => logs.push(m));
    assert.equal(docsRun, EXIT_OK);
    assert.match(logs.join('\n'), /仅文档\/元数据改动/);

    writeFileSync(path.join(dir, 'src', 'b.js'), 'export const b = 2;\n');
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'code']);
    g(dir, ['update-ref', ref, 'HEAD']);
    const codeRun = main(['--chain', file, '--repo', dir, '--mirror', ref, '--base', base], {}, () => {}, () => {});
    assert.equal(codeRun, EXIT_FAIL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main --mirror：无远端基线时退回最近 witness 覆盖祖先；链里没有祖先则拒', () => {
  const dir = makeRepo();
  try {
    const file = chainOf(dir);
    const att = attestCommit({ repoDir: dir, issue: '1', stdout: 'ok\n', gateBytes: 'g'.repeat(64), chainFile: file });
    assert.equal(att.ok, true);
    writeFileSync(path.join(dir, 'docs', 'b.md'), '# b\n');
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'docs']);

    const logs = [];
    const run = main(['--chain', file, '--repo', dir, '--mirror', 'HEAD'], {}, (m) => logs.push(m), (m) => logs.push(m));
    assert.equal(run, EXIT_OK);
    assert.match(logs.join('\n'), /最近 witness 覆盖提交/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const bare = makeRepo();
  try {
    const run = main(['--chain', chainOf(bare), '--repo', bare, '--mirror', 'HEAD'], {}, () => {}, () => {});
    assert.equal(run, EXIT_FAIL);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('main --mirror：基线提交本地不存在 → fail-closed', () => {
  const dir = makeRepo();
  try {
    const file = chainOf(dir);
    writeFileSync(path.join(dir, 'docs', 'b.md'), '# b\n');
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'docs']);
    const run = main(['--chain', file, '--repo', dir, '--mirror', 'HEAD', '--base', 'deadbeef'.repeat(5)], {}, () => {}, () => {});
    assert.equal(run, EXIT_FAIL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
