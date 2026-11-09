/**
 * drift-guard.mjs — P5.5 主仓漂移快照 + verify-clean（issue #236，来源 #229 对照表第 7、9 行）。
 *
 * 为什么要有它：worktree 的 git status 只看得到 agent 改了哪些文件，看不到两件更隐蔽的事：
 *   1) agent 改 `.git/info/exclude` 可以把文件从 `git status` 里藏掉（worktreeStatus 用的正是 --porcelain）；
 *   2) 任务期间主仓多出被忽略/未跟踪的条目（产物、缓存的凭据副本），事后没人对账。
 * 另外 bless 之后 HEAD 能不能复算（不带 --bless 再跑一遍门禁）也只靠云端 CI，调度器自己不看。
 *
 * 本模块只做「取证 + 判定」，不自己跑 git：run/git 由调用方注入，所以可以单测。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './gate-snapshot.mjs';

/** 既有产物目录：主仓出现这些新增条目不算漂移（.logs/ .worktrees/ dist/ 是调度链自己写的）。 */
export const ALLOW_PREFIXES = ['.logs/', '.worktrees/', 'dist/', '.backups/'];

export const DEFAULT_GIT = process.env.DSH_GIT || 'C:/Program Files/Git/cmd/git.exe';

/** `git status --porcelain -uall --ignored=matching` 的一行 → { flag, path }。
 *  忽略条目是 '!! path'，未跟踪是 '?? path'；带空格/中文的路径会被引号包住，去掉引号即可。
 */
export function parseStatus(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (raw.length < 4) continue;
    const flag = raw.slice(0, 2).trim();
    let p = raw.slice(3).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    if (!p) continue;
    out.push({ flag, path: p });
  }
  return out;
}

/** 快照：.git/info/exclude 的 sha256 + 逐行内容 + 主仓 status 条目。 */
export async function takeSnapshot({ repoDir, run, git = DEFAULT_GIT } = {}) {
  if (typeof run !== 'function') throw new Error('takeSnapshot 需要注入 run(cmd, args, opts)');
  const common = await run(git, ['rev-parse', '--git-common-dir'], { cwd: repoDir });
  if (common.code !== 0) throw new Error('git rev-parse --git-common-dir 失败: ' + String(common.err ?? '').trim());
  const commonDir = path.resolve(repoDir, String(common.out ?? '').trim() || '.git');
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  const excludeText = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
  const st = await run(git, ['status', '--porcelain', '-uall', '--ignored=matching'], { cwd: repoDir });
  if (st.code !== 0) throw new Error('git status 失败: ' + String(st.err ?? '').trim());
  return {
    excludeFile,
    excludeSha: sha256(Buffer.from(excludeText, 'utf8')),
    excludeLines: excludeText.split(/\r?\n/),
    entries: parseStatus(st.out),
  };
}

/** 逐行 diff（只用于把 exclude 的改动报出来，不追求最小编辑距离）。 */
export function lineDiff(before, after) {
  const b = (before ?? []).filter((l) => l.trim() !== '');
  const a = (after ?? []).filter((l) => l.trim() !== '');
  const removed = b.filter((l) => !a.includes(l)).map((text) => ({ type: '-', text }));
  const added = a.filter((l) => !b.includes(l)).map((text) => ({ type: '+', text }));
  return [...removed, ...added];
}

/** 比对前后快照。blocked 的两种情形：exclude 被改；主仓多出未被放行的新条目。 */
export function compareSnapshots(before, after, { allow = ALLOW_PREFIXES } = {}) {
  const excludeChanged = before.excludeSha !== after.excludeSha;
  const excludeDiff = excludeChanged ? lineDiff(before.excludeLines, after.excludeLines) : [];
  const seen = new Set(before.entries.map((e) => e.flag + ' ' + e.path));
  const added = after.entries.filter((e) => {
    if (seen.has(e.flag + ' ' + e.path)) return false;
    return !allow.some((p) => e.path === p.replace(/\/$/, '') || e.path.startsWith(p) || e.path.startsWith(p.replace(/\/$/, '') + '/'));
  });
  const blocked = excludeChanged || added.length > 0;
  return { ok: !blocked, blocked, excludeChanged, excludeDiff, added };
}

/** 人读的漂移报告（进失败指纹库的那段文本）。 */
export function formatRepoDrift(result) {
  if (!result.blocked) return '主仓无漂移';
  const lines = [];
  if (result.excludeChanged) {
    lines.push('[drift] .git/info/exclude 在任务期间被改动（可用来把文件从 git status 里藏掉）：');
    if (result.excludeDiff.length === 0) lines.push('  （内容逐行相同，仅行尾/空白或编码变化）');
    for (const d of result.excludeDiff) lines.push('  ' + d.type + ' ' + d.text);
  }
  if (result.added.length) {
    lines.push('[drift] 主仓出现新的被忽略/未跟踪条目：');
    for (const e of result.added) lines.push('  ' + e.flag + ' ' + e.path);
  }
  return lines.join('\n');
}

/** verify-clean 口径：不带 --bless 复跑门禁，必须 exit 0 且出现 VERDICT: PASS。 */
export function verifyCleanVerdict({ code, out } = {}) {
  const text = String(out ?? '');
  const pass = /^VERDICT: PASS\s*$/m.test(text);
  if (code !== 0) return { ok: false, why: 'verify-clean 复跑 exit ' + code + '（head 不可复算）' };
  if (!pass) return { ok: false, why: 'verify-clean 复跑没有 VERDICT: PASS 行（head 不可复算）' };
  return { ok: true, why: 'verify-clean 通过' };
}
