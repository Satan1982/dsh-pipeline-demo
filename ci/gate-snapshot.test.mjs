import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_GIT, gateBytesSha256, overlayOriginGate } from '../ci/gate-snapshot.mjs';

function git(cwd, args) {
  return execFileSync(DEFAULT_GIT, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-snap-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'drill@example.invalid']);
  git(dir, ['config', 'user.name', 'drill']);
  // 换行符归一会让「同样的字节」在 checkout 后变成 CRLF，哈希就不可比了——测试与生产都按 LF 记。
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'core.eol', 'lf']);
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  mkdirSync(path.join(dir, 'ci'), { recursive: true });
  writeFileSync(path.join(dir, 'scripts', 'verify.sh'), 'echo origin-gate\n');
  writeFileSync(path.join(dir, 'ci', 'policy.mjs'), 'export const v = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'origin']);
  // 本地建一个 origin/main 引用（不联网也能测快照语义）。
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return dir;
}

test('gate_bytes_sha256：任一字节变化，合并哈希必变', () => {
  const dir = makeRepo();
  const before = gateBytesSha256(dir).sha256;
  writeFileSync(path.join(dir, 'scripts', 'verify.sh'), 'echo origin-gate\n# tampered\n');
  const after = gateBytesSha256(dir).sha256;
  assert.notEqual(before, after);
  assert.equal(gateBytesSha256(dir).files.length, 2);
});

test('overlayOriginGate：工作树被改过，执行的仍是 origin 字节（负例：改工作树不影响哈希）', () => {
  const dir = makeRepo();
  const origin = gateBytesSha256(dir).sha256;
  writeFileSync(path.join(dir, 'scripts', 'verify.sh'), 'echo TAMPERED\n');
  writeFileSync(path.join(dir, 'ci', 'policy.mjs'), 'export const v = 999;\n');
  const snap = overlayOriginGate({ repoDir: dir });
  assert.equal(snap.sha256, origin, '覆盖后应等于 origin 的字节哈希');
  assert.equal(readFileSync(path.join(dir, 'scripts', 'verify.sh'), 'utf8'), 'echo origin-gate\n');
  assert.equal(readFileSync(path.join(dir, 'ci', 'policy.mjs'), 'utf8'), 'export const v = 1;\n');
});

test('overlayOriginGate：origin 前进后哈希跟着变（证明记的是被测版本）', () => {
  const dir = makeRepo();
  const v1 = overlayOriginGate({ repoDir: dir }).sha256;
  writeFileSync(path.join(dir, 'scripts', 'verify.sh'), 'echo origin-gate-v2\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'origin v2']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const v2 = overlayOriginGate({ repoDir: dir }).sha256;
  assert.notEqual(v1, v2);
});
