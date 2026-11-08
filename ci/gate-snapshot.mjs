#!/usr/bin/env node
// ci/gate-snapshot.mjs —— v3 P0（docs/89 §3.1）：门禁脚本从 `origin/main` 只读快照执行，
// 并记录「被执行的字节」的 sha256（gate_bytes_sha256）。
//
// 为什么：门禁脚本取自 agent 工作树是缺口（agent 改得动裁判）。这里在执行前先用 origin 的字节
// 覆盖工作树里的 scripts/ 与 ci/，再跑 verify.sh——跑的就是 origin 的那份，同时把字节哈希带回去，
// 让上方证据能证明「是哪份门禁判的」。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_REF = 'origin/main';
export const GATE_PATHS = ['scripts', 'ci'];
export const DEFAULT_GIT = process.env.DSH_GIT
  || (existsSync('C:/Program Files/Git/cmd/git.exe') ? 'C:/Program Files/Git/cmd/git.exe' : 'git');

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
  execFileSync(gitBin, ['checkout', ref, '--', ...paths], { cwd: repoDir, stdio: 'pipe' });
  return { ref, ...gateBytesSha256(repoDir, paths) };
}
