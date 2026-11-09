#!/usr/bin/env node
// ci/drills/launcher.mjs — §六「真实工单 drill：断开 launcher → 单子应 fail 而不是回退」的通道级复现
// （docs/security-remediation-20261109.md §六/§七 闸门 2/3）。
//
// 手法沿用已有的人工回归（.logs/exec-audit.jsonl 里的 actor=manual-regression）：直接调用
// runAsAgentCommand，但把 launcher 指到只会失败/伪造结果的 stub，验证三件事：
//   ① 没有 done.json → ok=false（不是「当成 exit 0」）；
//   ② 伪造 done.json（ok=true/exit=0，nonce 是假的）→ ok=false（nonce 不匹配）；
//   ③ 两种失败下 s4FallbackAction 都 fail-closed；只有显式 DSH_S4_FALLBACK=admin 才回退。
// 另查 git log 无 Administrator 提交（§六 第二条证据）。
// 审计写临时文件（DSH_EXEC_AUDIT），不会污染 .logs/exec-audit.jsonl 的覆盖率。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GIT = 'C:/Program Files/Git/cmd/git.exe';
const ROOT = 'C:\\ProgramData\\dsh-jobs\\launcher-drill';
const CWD = 'C:\\ProgramData\\dsh-gate\\drill';
const tmp = mkdtempSync(path.join(tmpdir(), 'dsh-launcher-drill-'));
const auditFile = path.join(tmp, 'exec-audit.jsonl');

// 先给小根目录放行，stub launcher 才能被 Administrator 读到（runOnce 以当前身份 spawn）。
mkdirSync(ROOT, { recursive: true });
mkdirSync(CWD, { recursive: true });

const stubForge = path.join(tmp, 'stub-forge.ps1');
writeFileSync(stubForge, [
  'param([string]$JobDir, [string]$Runner)',
  '$done = Join-Path $JobDir "done.json"',
  '@{ ok = $true; exit = 0; nonce = \'forged\' } | ConvertTo-Json -Compress | Set-Content -Path $done -Encoding ascii',
  'exit 0',
  '',
].join('\n'));

const stubFail = path.join(tmp, 'stub-fail.ps1');
writeFileSync(stubFail, [
  'param([string]$JobDir, [string]$Runner)',
  '# 断开 launcher：什么都不写，直接失败（模拟 s4-as-agent.ps1 起不来）',
  'exit 1',
  '',
].join('\n'));

process.env.DSH_EXEC_AUDIT = auditFile;
process.env.DSH_CMD_JOB_DIR = path.join(ROOT, 'cmd');
process.env.DSH_S4_DONE_GRACE_MS = '3000';
process.env.DSH_S4_LAUNCHER = stubForge;
const { runAsAgentCommand, s4FallbackAction } = await import('../s4-exec.mjs');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` — ${detail}`}`);
};

// ① 伪造 done.json：launcher 退出 0，但 nonce 对不上。
const forged = await runAsAgentCommand({ cmd: 'bash scripts/verify.sh', cwd: CWD, timeoutSec: 30, actor: 'drill-forged' });
check('伪造 done.json 被非零 nonce 拒', forged.ok === false, JSON.stringify({ ok: forged.ok, code: forged.code, error: forged.error }));
check('伪造 done.json 的报错说明 nonce 不匹配', /nonce/.test(forged.error) === true, forged.error);
check('伪造 done.json 不产生成功结果', forged.done !== null && forged.ok === false, String(forged.ok));

// ② 断开 launcher：没有 done.json。
process.env.DSH_S4_LAUNCHER = stubFail;
const broken = await runAsAgentCommand({ cmd: 'bash scripts/verify.sh', cwd: CWD, timeoutSec: 30, actor: 'drill-broken' });
check('launcher 断开 → 单子 fail（ok=false）', broken.ok === false, JSON.stringify({ ok: broken.ok, code: broken.code, error: broken.error }));
check('launcher 断开 → code=-1 且没有 done', broken.code === -1 && broken.done === null, JSON.stringify({ code: broken.code, done: broken.done }));
check('launcher 断开 → 报错指向 launcher', /没有有效 done\.json|launcher exit/.test(broken.error) === true, broken.error);

// ③ fail-closed：默认不回退；只有显式 admin 才回退。
check('失败默认 fail-closed', s4FallbackAction(undefined, broken.error).fail === true, '默认竟然回退');
check('失败 + 空串仍 fail-closed', s4FallbackAction('', broken.error).fail === true, '空串竟然回退');
check('失败 + admin 才回退', s4FallbackAction('admin', broken.error).fail === false, '显式 admin 却没有回退');

// 审计：两次都落盘且都不 ok。
const audit = existsSync(auditFile) ? readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
check('审计落了两条执行记录', audit.length === 2, `实际 ${audit.length}`);
check('审计记录都不是 ok', audit.every((r) => r.ok === false) === true, JSON.stringify(audit.map((r) => r.ok)));

// ④ §六 第二条证据：git log 无 Administrator 提交。
const git = spawnSync(GIT, ['-C', REPO, 'log', '--format=%an'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
const admins = String(git.stdout || '').split('\n').filter((s) => s.trim() === 'Administrator').length;
check('git log 无 Administrator 提交', git.status === 0 && admins === 0, `status=${git.status} admins=${admins}`);

rmSync(tmp, { recursive: true, force: true });
const bad = results.filter((r) => !r.ok).length;
if (bad) {
  console.log(`\n${bad}/${results.length} 条没通过`);
  console.log('VERDICT: FAIL launcher 断开没有 fail-closed');
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} 通过`);
console.log('VERDICT: PASS');
