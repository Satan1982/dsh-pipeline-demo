#!/usr/bin/env node
// ci/gate-snapshot.mjs —— v3 P0（docs/89 §3.1）：门禁脚本从 `origin/main` 只读快照执行，
// 并记录「被执行的字节」的 sha256（gate_bytes_sha256）。
//
// 为什么：门禁脚本取自 agent 工作树是缺口（agent 改得动裁判）。这里在执行前先用 origin 的字节
// 覆盖工作树里的 scripts/ 与 ci/，再跑 verify.sh——跑的就是 origin 的那份，同时把字节哈希带回去，
// 让上方证据能证明「是哪份门禁判的」。
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_REF = 'origin/main';
export const GATE_PATHS = ['scripts', 'ci'];
// 门禁路径里唯一的"数据"例外：--bless 基线。它们不是可执行代码，agent 必须能同步。
export const BASELINE_FILES = ['scripts/test-baseline.txt', 'scripts/assert-baseline.txt'];
export const DEFAULT_GIT = process.env.DSH_GIT
  || (existsSync('C:/Program Files/Git/cmd/git.exe') ? 'C:/Program Files/Git/cmd/git.exe' : 'git');

// 候选树的删除权限（2026-11-09 真实单 #231 实测的 P0）：
// 候选树里的 dist/ 等产物是低权用户 dsh-agent 建的；它的 ACL 只把 FullControl 给了
// BUILTIN\Administrators，而调度器跑在「UAC 过滤后的管理员」令牌里——Administrators 是
// deny-only SID，那条 ACE 不生效，于是调度器自己删不掉 dsh-agent 建的文件（EPERM）。
// 这不是「偶发句柄占用」：attempt 2/3 每次都复现，且 `rm` 手删同样 Permission denied。
// 修法两件：①建树时给「当前登录用户」(OI)(CI)F，子文件继承后调度器才删得动；
// ②删不掉也不能判任务失败（候选树是临时物），交给巡检清扫。
export function currentUserSpec(env = process.env) {
  const user = env.USERNAME;
  if (!user) return '';
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

// 递归给当前用户完全控制（/T 覆盖已存在的子文件，新建的子文件靠 (OI)(CI) 继承）。
export function grantTreeForCurrentUser(dir, { spec = currentUserSpec(), run = spawnSync } = {}) {
  if (!spec) return { ok: false, why: '拿不到当前用户名（USERNAME 为空）' };
  const r = run('icacls', [dir, '/grant', `${spec}:(OI)(CI)F`, '/T', '/Q'], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, why: (r.stderr || r.stdout || '').trim().slice(-300) || 'icacls 非零退出' };
  return { ok: true };
}

// 删一棵临时树：先直删，EPERM/EACCES 就先补 ACL 再删一次；仍失败就如实报出来，
// 但**永远不抛**——清理失败是「留下垃圾」，不是「任务失败」。
export function removeTreeSafe(dir, { rm = rmSync, grant = grantTreeForCurrentUser } = {}) {
  const opts = { recursive: true, force: true, maxRetries: 3, retryDelay: 150 };
  try {
    rm(dir, opts);
    return { ok: true };
  } catch (e1) {
    let why = e1.message;
    try {
      const g = grant(dir);
      if (!g.ok) why = `${why}；补 ACL 失败：${g.why}`;
    } catch (e) {
      why = `${why}；补 ACL 异常：${e.message}`;
    }
    try {
      rm(dir, opts);
      return { ok: true, via: 'acl' };
    } catch (e2) {
      return { ok: false, why: `${e2.message}（首次：${why}）` };
    }
  }
}

// 清扫上次留下来、删不掉的候选树（按 mtime 判新，避免误删并发在跑的）。
export function sweepCandidates(root, { olderThanMs = 60 * 60 * 1000, now = Date.now(), remove = removeTreeSafe } = {}) {
  const removed = [];
  const kept = [];
  if (!existsSync(root)) return { removed, kept };
  for (const name of readdirSync(root)) {
    if (!name.startsWith('cand-')) continue;
    const abs = path.join(root, name);
    let age;
    try {
      age = now - statSync(abs).mtimeMs;
    } catch {
      continue;
    }
    if (age < olderThanMs) {
      kept.push(name);
      continue;
    }
    const r = remove(abs);
    (r.ok ? removed : kept).push(name);
  }
  return { removed, kept };
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function walk(dir, base, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out;
}

// 逐文件 + 合并哈希。被执行的字节一变，合并哈希必变（负例见 gate-snapshot.test.mjs）。
export function gateBytesSha256(root, paths = GATE_PATHS) {
  const files = [];
  for (const p of paths) {
    const abs = path.join(root, p);
    if (!existsSync(abs)) throw new Error(`门禁路径不存在: ${abs}`);
    const list = statSync(abs).isDirectory() ? walk(abs, root) : [p];
    for (const rel of list.sort()) {
      files.push({ path: rel, sha256: sha256(readFileSync(path.join(root, rel))) });
    }
  }
  const combined = sha256(files.map((f) => `${f.path}:${f.sha256}`).join('\n'));
  return { sha256: combined, files };
}

// 失败即抛（调用方 fail-closed）：拿不到 origin 字节就不该判定门禁通过。
export function overlayOriginGate({ repoDir, ref = DEFAULT_REF, gitBin = DEFAULT_GIT, paths = GATE_PATHS } = {}) {
  if (!repoDir) throw new Error('缺 repoDir');
  execFileSync(gitBin, ['checkout', ref, '--', ...paths], { cwd: repoDir, stdio: 'pipe', windowsHide: true });
  return { ref, ...gateBytesSha256(repoDir, paths) };
}

// v3 P2 遗留（docs/89 §3.1 line 53）：门禁不再在「agent 的脏工作树」上直接跑。
// 把候选树物化到临时 worktree（HEAD + 已跟踪改动 patch + 未跟踪新文件），再用 origin 的
// scripts/ci 覆盖，最后在临时目录里跑 verify.sh。好处：
//   1) 跑之前工作树就是干净的，agent 事后改文件影响不到这次判定；
//   2) 门禁字节与工作树状态解耦，同一候选树可重放；
//   3) 不再把 origin 门禁 checkout 进 agent 的工作树（历史上会把它写脏，和「脏树拒签」打架）。
export function prepareCandidateTree({ repoDir, ref = 'HEAD', gateRef = DEFAULT_REF, gitBin = DEFAULT_GIT, paths = GATE_PATHS, keep = false, root = os.tmpdir(), prefix = 'dsh-gate-' } = {}) {
  if (!repoDir) throw new Error('缺 repoDir');
  // root：门禁要能以低权用户跑，而低权进程穿不过管理员的 %TEMP%。
  // 调用方传 C:\ProgramData\dsh-gate（见 ci/s4-exec.mjs ensureCandidateRoot）时，候选树才在
  // dsh-agent 可达的位置；默认仍留 os.tmpdir() 给纯本地调用。
  mkdirSync(root, { recursive: true });
  const tmp = mkdtempSync(path.join(root, prefix));
  const cleanup = () => {
    try {
      execFileSync(gitBin, ['worktree', 'remove', '--force', tmp], { cwd: repoDir, stdio: 'pipe', windowsHide: true });
    } catch { /* 已删/未注册都不影响清理 */ }
    if (keep) return { ok: true, kept: true };
    return removeTreeSafe(tmp);
  };
  try {
    execFileSync(gitBin, ['worktree', 'add', '--detach', '--quiet', tmp, ref], { cwd: repoDir, stdio: 'pipe', windowsHide: true });
    // 1) 已跟踪但还没提交的改动：原样 patch 过去（--binary 防止图片/二进制被截断）。
    const patch = execFileSync(gitBin, ['diff', '--binary', ref], { cwd: repoDir, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (patch.length > 0) {
      const patchFile = path.join(tmp, '.dsh-candidate.patch');
      writeFileSync(patchFile, patch);
      execFileSync(gitBin, ['apply', '--whitespace=nowarn', patchFile], { cwd: tmp, stdio: 'pipe', windowsHide: true });
      rmSync(patchFile, { force: true });
    }
    // 2) 未跟踪的新文件（git archive 看不到它们，但 agent 新建的源文件/测试必须进候选树）。
    const untracked = execFileSync(gitBin, ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: repoDir, encoding: 'utf8', windowsHide: true })
      .split('\0').filter(Boolean);
    for (const rel of untracked) {
      const from = path.join(repoDir, rel);
      if (!existsSync(from) || !statSync(from).isFile()) continue;
      const to = path.join(tmp, rel);
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
    // 3) 门禁字节仍取 gateRef（默认 origin/main）：agent 改不动裁判。
    // 例外：两个基线 txt 是 --bless 数据（不是可执行门禁代码，另受 assert-guard 指纹保护），
    // agent 必须能在 PR 里同步它们；若被一起 checkout 回 origin，任何「加/改测试」的工单都会在
    // 调度器门禁里被判「基线未更新」（review.mjs 也已对这两个文件豁免 gate-modified）。
    // 顺序：先取哈希（证明跑的就是 origin 门禁字节），再把候选树的基线数据放回来。
    // 候选树里的基线数据先留存，overlay 之后再放回（见下方说明）。
    const blessed = new Map();
    for (const rel of BASELINE_FILES) {
      const abs = path.join(tmp, rel);
      if (existsSync(abs)) blessed.set(rel, readFileSync(abs));
    }
    execFileSync(gitBin, ['checkout', gateRef, '--', ...paths], { cwd: tmp, stdio: 'pipe', windowsHide: true });
    const gate = gateBytesSha256(tmp, paths);
    for (const [rel, buf] of blessed) writeFileSync(path.join(tmp, rel), buf);
    return { dir: tmp, ref, gateRef, gate, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}
