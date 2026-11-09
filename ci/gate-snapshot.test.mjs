import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_GIT, gateBytesSha256, overlayOriginGate, prepareCandidateTree, removeTreeSafe, sweepCandidates } from '../ci/gate-snapshot.mjs';

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

test('prepareCandidateTree：已跟踪改动 + 未跟踪新文件进候选树，门禁字节仍取 origin', () => {
  const dir = makeRepo();
  writeFileSync(path.join(dir, 'notes.md'), 'v1\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'notes v1']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  writeFileSync(path.join(dir, 'notes.md'), 'v2\n');
  writeFileSync(path.join(dir, 'new-src.mjs'), 'export const x = 1;\n');
  writeFileSync(path.join(dir, 'scripts', 'verify.sh'), 'echo TAMPERED\n');

  const cand = prepareCandidateTree({ repoDir: dir });
  try {
    assert.equal(readFileSync(path.join(cand.dir, 'notes.md'), 'utf8'), 'v2\n', '未提交改动要进候选树');
    assert.equal(readFileSync(path.join(cand.dir, 'new-src.mjs'), 'utf8'), 'export const x = 1;\n', '未跟踪新文件要进候选树');
    assert.equal(readFileSync(path.join(cand.dir, 'scripts', 'verify.sh'), 'utf8'), 'echo origin-gate\n', '门禁字节必须被 origin 覆盖');
    assert.equal(cand.gate.sha256, gateBytesSha256(cand.dir).sha256);
    // 原工作树不被门禁 checkout 写脏：agent 的 TAMPERED 字节原样保留（供评审/取证）。
    assert.equal(readFileSync(path.join(dir, 'scripts', 'verify.sh'), 'utf8'), 'echo TAMPERED\n');
  } finally {
    cand.cleanup();
  }
  assert.equal(existsSync(cand.dir), false, 'cleanup 要删临时目录');
});

// 2026-11-09：overlay 曾把 --bless 基线 txt 一起 checkout 回 origin，导致「加/改测试」的工单
// 在调度器门禁里被判「基线未更新」（review 层却已豁免）。基线是数据不是门禁代码：
// 候选树必须保留 agent bless 后的内容，而 gate 哈希仍只代表 origin 的门禁字节。
test('prepareCandidateTree：--bless 基线留在候选树，门禁哈希仍按 origin 字节', () => {
  const dir = makeRepo();
  writeFileSync(path.join(dir, 'scripts', 'test-baseline.txt'), '21 49\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'origin baseline']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const originHash = gateBytesSha256(dir).sha256;

  // agent 加了测试并 --bless：基线数字前进（未提交）。
  writeFileSync(path.join(dir, 'scripts', 'test-baseline.txt'), '22 50\n');

  const cand = prepareCandidateTree({ repoDir: dir });
  try {
    assert.equal(readFileSync(path.join(cand.dir, 'scripts', 'verify.sh'), 'utf8'), 'echo origin-gate\n');
    assert.equal(readFileSync(path.join(cand.dir, 'scripts', 'test-baseline.txt'), 'utf8'), '22 50\n',
      'bless 后的基线必须留在候选树（否则门禁判基线未更新）');
    assert.equal(cand.gate.sha256, originHash, 'gate 哈希只能代表 origin 门禁字节，不能掺进基线数据');
  } finally {
    cand.cleanup();
  }
});

// 2026-11-09 真实单 #231：候选树里的产物由低权用户 dsh-agent 建，管理员组的 ACE 在 UAC
// 过滤令牌里是 deny-only，调度器自己删不掉 → EPERM 把「门禁全绿」的尝试整单判失败。
test('removeTreeSafe：直删成功不加 ACL', () => {
  const calls = [];
  const r = removeTreeSafe('x', {
    rm: (dir, opts) => { calls.push(opts); },
    grant: () => { throw new Error('不该补 ACL'); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, undefined);
  assert.equal(calls.length, 1);
});

test('removeTreeSafe：首删 EPERM → 补 ACL 后成功（via=acl）', () => {
  let n = 0;
  const grants = [];
  const r = removeTreeSafe('x', {
    rm: () => { n += 1; if (n === 1) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
    grant: (dir) => { grants.push(dir); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'acl');
  assert.deepEqual(grants, ['x']);
});

test('removeTreeSafe：两次都删不掉 → ok:false 且不抛出（清理失败不判任务失败）', () => {
  const r = removeTreeSafe('x', {
    rm: () => { throw Object.assign(new Error('EPERM, Permission denied: x/dist'), { code: 'EPERM' }); },
    grant: () => ({ ok: false, why: 'icacls 非零退出' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /EPERM/);
  assert.match(r.why, /icacls/);
});

test('sweepCandidates：只扫 cand-*，只删旧的，删不掉的进 kept', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gate-sweep-'));
  const now = 1_700_000_000_000;
  const mk = (name, ageMs) => {
    const abs = path.join(root, name);
    mkdirSync(abs, { recursive: true });
    utimesSync(abs, new Date(now - ageMs), new Date(now - ageMs));
    return abs;
  };
  const oldCand = mk('cand-old', 2 * 60 * 60 * 1000);
  const newCand = mk('cand-new', 5 * 60 * 1000);
  const oldOther = mk('other-old', 2 * 60 * 60 * 1000);
  const oldStuck = mk('cand-stuck', 3 * 60 * 60 * 1000);
  const removed = [];
  const r = sweepCandidates(root, {
    now,
    remove: (dir) => {
      if (path.basename(dir) === 'cand-stuck') return { ok: false, why: 'EPERM' };
      removed.push(path.basename(dir));
      return { ok: true };
    },
  });
  assert.deepEqual(r.removed, ['cand-old']);
  assert.equal(r.kept.sort().join(','), 'cand-new,cand-stuck');
  assert.equal(removed.includes('other-old'), false, '非 cand- 前缀一律不碰');
  for (const p of [oldCand, newCand, oldOther, oldStuck]) assert.ok(existsSync(p), '注入的 remove 不真删');
});
