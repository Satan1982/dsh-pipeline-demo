#!/usr/bin/env node
/**
 * dispatch.mjs — GitHub Issues → DSH headless agent → PR
 *
 * 轮询带 `agent:ready` label 的 issue，在隔离 worktree 里让 headless agent 干活，
 * 通过后自动推分支并开 PR。人只负责写 issue 和 review/merge。
 *
 * 用法:
 *   node ci/dispatch.mjs --ensure   确保后台有常驻调度器（没有就脱离父进程拉起一个）
 *   node ci/dispatch.mjs --serve    常驻轮询（--ensure 拉起时用它；不带参数默认也是它）
 *   node ci/dispatch.mjs --once     跑一轮就退出（适合本地验证与计划任务）
 *   node ci/dispatch.mjs --unattended  无人值守语义（= DSH_UNATTENDED=1；计划任务的动作里带上）
 *   node ci/dispatch.mjs --dry-run  只列出待办 issue，不执行
 *   node ci/dispatch.mjs --probe-stale  只探活免费池里 stale/unknown 的模型，不领任务
 *   node ci/dispatch.mjs --repos repos.json  按多库清单各起一个常驻（每库独立日志/锁/worktree）
 *   node ci/dispatch.mjs --status   只读体检：锁、暂停态、今日花费（绝不领单、绝不常驻）
 *   node ci/dispatch.mjs --pause --why "原因"  持久暂停（落 .logs/state.json，重启不清零）
 *   node ci/dispatch.mjs --resume   解除暂停
 *   未知旗标会被拒绝（exit 2）：以前它不报错，而是静默掉进常驻轮询。
 *
 * 环境变量:
 *   DSH_REPO               owner/repo，默认 Satan1982/dsh-pipeline-demo
 *   DSH_POLL_INTERVAL      轮询秒数，默认 60
 *   DSH_TASK_TIMEOUT_MS    单任务超时，默认 30 分钟
 */
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fingerprint, recordFailure, formatPriorFailures } from './failures.mjs';
import { headlessKind } from './headless-kind.mjs';
import { sumUsage, formatUsage, finalText, sessionIdOf, spendOfRows, UNMETERED_UNIT_CNY } from './usage.mjs';
import { costCny, formatCny } from './prices.mjs';
import { reviewWorktree, formatFindings } from './review.mjs';
import { writeGateLog } from './gate-log.mjs';
import { probeWorktree, testPathFor } from './mutate.mjs';
import { takeSnapshot, compareSnapshots, formatRepoDrift, verifyCleanVerdict } from './drift-guard.mjs';
import { gateFilesFromFindings } from './gate-override.mjs';
import { parseBaseline, countAssertions, findNewExports, checkAssertDelta, checkSymbolBinding, checkEvidence, summarize as summarizeFalsifier, TEST_FILE_RE } from './falsifier.mjs';
import { prepareCandidateTree, grantTreeForCurrentUser, sweepCandidates, BASELINE_FILES } from './gate-snapshot.mjs';
import { runAsAgentCommand, commandPolicy, isTrustedAuthor, isTrustedLabeler, collaboratorLogins, ensureCandidateRoot, grantDir, execAuditPath, s4FallbackAction } from './s4-exec.mjs';
import { parseAudit, countFallbackEvents, summarizeS4Coverage, formatS4Coverage } from './s4-coverage.mjs';
import { attestCommit, assertHeadWitnessed, defaultChainFile } from './trust/verify.mjs';
import { loadKeyring } from './trust/keys.mjs';
import { redactPublicPayload } from './redact.mjs';
import { fenceUntrusted, FENCE_DECLARATION } from './prompt-fence.mjs';
import { formatFirstError, parseFirstError } from './metrics.mjs';
import { HIGH_RISK_LABEL, defaultLaneStatsFile, findRunJs, formatLaneLine, lanePolicy, laneStats, loadLaneStats, parseLane, recordLane, runHighRiskAdapter } from './risk-lane.mjs';
import { collectDiff, reviewWithPanel, formatSemantic, pickFreeModels, registryStats, FREE_STRONG_MODELS } from './semantic-review.mjs';
import { classifyConflicts } from './rebase-conflict.mjs';
import { decideAcceptance } from './verdict.mjs';
import { freePoolDecision, blockReason } from './pool-block.mjs';
import { startLlmProxy } from './llm-proxy.mjs';
import { recoveryDecision, initialEntry, isDue, parseBackoff, pruneState, MAX_AUTO_REQUEUE } from './blocked-recovery.mjs';
import { decideRequeue } from './requeue-policy.mjs';
import { missingLabels, labelPayload, formatLabelList } from './labels.mjs';
import { DEFAULT_BEAT_STALE_MS, lockHeld, lockPayload } from './lock-policy.mjs';
import { auditWorktrees, formatAudit, parseWorktreeDirs } from './worktree-audit.mjs';
import { formatDrift, localDrift } from './drift.mjs';
import { parseRuntime, readState, setPaused, clearPaused, formatStatus, reconcilePause } from './runtime-state.mjs';
import { appendEvent, eventRecord, psToastBody, toastText, writeToastScript, regAddArgs, regQueryArgs, settingsKey, postWebhook } from './notify.mjs';
import { checkUnattendedIntake } from './intake-check.mjs';
import { NEEDS_INFO_LABEL, buildNeedsInfoComment, buildNeedsInfoMail } from './needs-info.mjs';
import { appendLedger, defaultLedgerFile, ledgerEntry } from './ledger.mjs';
import { listModels, probeArgv, staleTargets, summarizeProbe, planProbe, poolCounts, INCLUDE_PAID_ENV } from './probe-plan.mjs';
import { parseRepos, childEnv, formatPlan } from './repos.mjs';
import { ENV_KEY as AUTO_MERGE_ENV, PILOT_REPO, parseAllowlist, decideAutoMerge } from './merge-policy.mjs';
import { homedir } from 'node:os';
import { runAsAgent } from './s4-job.mjs';

// Windows 上 Node 自带 CA 不含系统根证书，必须 --use-system-ca，否则 api.github.com 报
// "unable to verify the first certificate"。没有该 flag 时自重启补上。
if (!process.execArgv.includes('--use-system-ca')) {
  const r = spawnSync(process.execPath, ['--use-system-ca', ...process.argv.slice(1)], { stdio: 'inherit', windowsHide: true });
  process.exit(r.status ?? 1);
}

const REPO      = process.env.DSH_REPO ?? PILOT_REPO;
// 自动合并的仓库白名单：缺省只有试点仓；真实仓要开，必须在启动环境里显式列出（空串=全禁）。
const AUTO_MERGE_ALLOWLIST = parseAllowlist(process.env[AUTO_MERGE_ENV]);
const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const io_url = fileURLToPath(import.meta.url);
const REPO_DIR_RAW = path.dirname(path.dirname(io_url));
const SECRETS_DIR = process.env.DSH_SECRETS_DIR || path.join(path.dirname(REPO_DIR_RAW), '.secrets');
const TOKEN_FILE = process.env.DSH_GITHUB_TOKEN_FILE || path.join(SECRETS_DIR, 'github-token.txt');
// 惰性读取：模块顶层读文件会让 CI 里的「能否 import」测试直接失败（那里没有 token 文件）。
let TOKEN_CACHE = '';
function token() {
  if (!TOKEN_CACHE) TOKEN_CACHE = readFileSync(TOKEN_FILE, 'utf8').trim();
  return TOKEN_CACHE;
}
const GIT = process.env.DSH_GIT || 'C:/Program Files/Git/cmd/git.exe';
// 提交钩子隔离（P0-2b）：调度器以 Administrator 提交时，不能让 worktree 里 agent 可写的
// .githooks（core.hooksPath 指向它）执行 Administrator 权限的脚本。这个目录不存在，git 视作无钩子；
// agent 自己的提交仍走 worktree 的 .githooks（那时是低权身份，改了也只影响自己）。
const SAFE_HOOKS = ['-c', 'core.hooksPath=C:/ProgramData/dsh-gate/.no-hooks'];
const BASH = process.env.DSH_BASH || path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', '@dsh-ops', 'bash-win32-x64', 'bin', 'bash.exe');
const ASKPASS = process.env.DSH_ASKPASS || path.join(SECRETS_DIR, 'askpass.sh');
const REPO_DIR = REPO_DIR_RAW;
const WT_ROOT = process.env.DSH_WORKTREES || path.join(path.dirname(REPO_DIR), '.worktrees');
// 低权隔离开关：默认开（agent 以 dsh-agent 身份跑，见 docs/77 §8）；`DSH_S4_AGENT=0` 显式退回旧行为。
// 隔离下 agent 拿不到 .secrets 里的任何 key，所以强模型/付费路由一律降级到仓内本地免费档。
const S4_ON = process.env.DSH_S4_AGENT !== '0';
// 默认强模型走免费池（modelscope 的 DeepSeek-V4.1-Flash-1017，账面 0 元）；
// 付费路由只在工单明确打 model:paid 时才用，且日志里会说。
let STRONG_PATCH = process.env.DSH_HEADLESS_STRONG_PATCH || path.join(SECRETS_DIR, 'headless-model-free-strong.yml');
// 付费档用 DSH 设置里那档 flash（deepseek-official），不用第三方付费 provider。
const PAID_PATCH = process.env.DSH_HEADLESS_PAID_PATCH || path.join(SECRETS_DIR, 'headless-model-paid.yml');
const REBASE_AGENT_TIMEOUT_MS = Number(process.env.DSH_REBASE_TIMEOUT_MS ?? 8 * 60 * 1000);
// 免费池的强模型会下线/换名，所以启动时现选一个，写成 patch 文件交给 headless。
// 显式设了 DSH_HEADLESS_STRONG_PATCH 就完全不动（调试/回滚用）。
let STRONG_MODEL_NAME = '';

// ── S4 低权代理（docs/77 §8）────────────────────────────────────────────────
// agent 拿不到真 key：调度器读 provider patch 的 apiKeyEnv、起 loopback 代理、
// 生成一份只含「代理地址 + 一次性 token 变量名」的 patch。token 走任务 env（不进文件）。
const CRED_FILE = process.env.DSH_CREDENTIALS || path.join(HOME, '.dsh', '.credentials.yaml');
const PROXY_TOKEN_VAR = ['DSH', 'PROXY', 'TOKEN'].join('_');

function readCredential(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(CRED_FILE, 'utf8').split(/\r?\n/).find((l) => l.trim().startsWith(`${name}:`));
    if (!line) return '';
    return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return '';
  }
}

function parsePatchRoute(file) {
  const text = readFileSync(file, 'utf8');
  const one = (re) => (re.exec(text)?.[1] ?? '').trim();
  return {
    baseURL: one(/^\s*baseURL:\s*(\S+)\s*$/m),
    apiKeyEnv: one(/^\s*apiKeyEnv:\s*(\S+)\s*$/m),
    model: one(/^\s*model:\s*(\S+)\s*$/m),
  };
}

async function startTaskProxy(kind, tag) {
  const src = kind === 'paid' ? PAID_PATCH : STRONG_PATCH;
  let route;
  try {
    route = parsePatchRoute(src);
  } catch (e) {
    log(`${tag} ⚠ 代理：读不到路由 patch ${src}（${e.message}）`);
    return null;
  }
  if (!route.baseURL || !route.apiKeyEnv) {
    log(`${tag} ⚠ 代理：${kind} 路由缺 baseURL/apiKeyEnv（${src}）`);
    return null;
  }
  const upstreamKey = readCredential(route.apiKeyEnv);
  if (!upstreamKey) {
    log(`${tag} ⚠ 代理：没有 ${route.apiKeyEnv} 凭据（$DSH_CREDENTIALS 或环境变量），回退 fail-closed`);
    return null;
  }
  const proxy = await startLlmProxy({
    upstream: route.baseURL,
    apiKey: upstreamKey,
    log: (m) => log(`${tag} ${m}`),
  });
  // 只替换地址与密钥变量名；模型/provider 原样保留，文件里没有密钥。
  let text = readFileSync(src, 'utf8');
  text = text.replace(/^(\s*)baseURL:\s*\S+.*$/m, `$1baseURL: ${proxy.baseURL}`);
  text = text.replace(/^(\s*)apiKeyEnv:\s*\S+.*$/m, `$1apiKeyEnv: ${PROXY_TOKEN_VAR}`);
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const patchFile = path.join(LOG_DIR, `headless-proxy-${kind}-${process.pid}-${proxy.port}.yml`);
  writeFileSync(patchFile, text);
  log(`${tag} 代理已起：${proxy.baseURL} → ${route.baseURL}（${route.model || kind}）`);
  return { ...proxy, patchFile };
}

function writeStrongPatch(model) {
  STRONG_MODEL_NAME = model;
  const file = path.join(LOG_DIR, 'headless-model-free-strong.generated.yml');
  const yml = [
    '# 调度器启动时按免费池健康快照生成，不要手改。',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      modelscope:',
    '        displayName: ModelScope free',
    '        apiKeyEnv: MODELSCOPE_API_TOKEN',
    '        api: openai-completions',
    '        baseURL: https://api-inference.modelscope.cn/v1',
    '        defaultContextWindow: 131072',
    '        defaultMaxTokens: 16384',
    '        models:',
    `          - id: ${model}`,
    `            name: ${model} (free)`,
    '            contextWindow: 131072',
    '            maxTokens: 16384',
    '            input:',
    '              - text',
    '- id: agent-default-model',
    '  config:',
    '    provider: modelscope',
    `    model: ${model}`,
  ].join(NL) + NL;
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(file, yml);
  return file;
}

function prepareStrongPatch() {
  if (process.env.DSH_HEADLESS_STRONG_PATCH) return STRONG_PATCH;
  try {
    const model = pickFreeModels(registryStats(), FREE_STRONG_MODELS, 1)[0];
    if (model) STRONG_PATCH = writeStrongPatch(model);
  } catch { /* 读不到免费池就用默认 patch 文件 */ }
  return STRONG_PATCH;
}


const TIMEOUT = Number(process.env.DSH_TASK_TIMEOUT_MS ?? 30 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.DSH_MAX_ATTEMPTS ?? 3);
// 花钱的三个闸：单任务上限、单日上限、留痕阈值（低于阈值只打日志，不写 issue 评论）。
const TASK_MAX_CNY = Number(process.env.DSH_TASK_MAX_CNY ?? 0.5);
const DAY_MAX_CNY = Number(process.env.DSH_DAY_MAX_CNY ?? 5);
const NOTIFY_CNY = Number(process.env.DSH_NOTIFY_CNY ?? 0.05);
// 限流不是逻辑失败：单独计数、单独上限，不占 MAX_ATTEMPTS 的预算。
const RATE_LIMIT_RETRIES = new Map();
// 环境失败（沙箱不让 spawn / exit 78）同样不该占 MAX_ATTEMPTS：单独记账，重试用尽就挂起。
// 环境变量可能被写成 "abc"/负数：NaN 或 <1 会让重试次数变 0 或 NaN 比较恒真，这里统一消毒。
const envLimit = (raw, dflt) => {
  const v = Math.floor(Number(raw));
  return Number.isFinite(v) && v >= 1 ? v : dflt;
};
const ENV_RETRY_MAX = envLimit(process.env.DSH_ENV_RETRY_MAX, 2);
const ENV_RETRIES = new Map();
const RATE_LIMIT_MAX = envLimit(process.env.DSH_RATE_LIMIT_MAX, 4);
// 等待时长同样消毒：NaN 会让 setTimeout 立即返回，退化成「一秒内连撞上限」。
const waitMs = (raw, dflt) => {
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const rateLimitWaitMs = () => waitMs(process.env.DSH_RATE_LIMIT_WAIT_MS, 120000);
const envRetryWaitMs = () => waitMs(process.env.DSH_ENV_RETRY_WAIT_MS, 60000);
// dsh 每个 headless 运行都会在 <home>/.dsh/sessions/<cwd 转义>/session-<uuid>/ 下留一份会话。
// worktree 用完就删了，这些会话会一直堆着（2026-10-26 实测 2 天堆了 95 个）。开机时把「工作区已不存在」
// 的那些整体移进 sessions-archived/pipeline-old（只搬不删），并清掉空的转义壳。
const SESSIONS_DIR = path.join(HOME, '.dsh', 'sessions');
const SESSIONS_ARCHIVE = path.join(HOME, '.dsh', 'sessions-archived', 'pipeline-old');

function escapeCwd(p) {
  return '--' + p.replace(/:/g, '').replace(/[\/]/g, '-') + '--';
}

async function pruneDeadSessions() {
  // --dry-run 是只读承诺：归档会话会搬目录，别在试跑里动它。
  if (DRY) { log('[dry-run] 跳过已删 worktree 的会话归档'); return 0; }
  const listed = (await git(['worktree', 'list', '--porcelain'])).out;
  const live = new Set(
    listed.split(NL).filter((l) => l.startsWith('worktree ')).map((l) => escapeCwd(l.slice('worktree '.length).trim())),
  );
  if (!existsSync(SESSIONS_DIR)) return 0;
  let moved = 0;
  for (const shard of readdirSync(SESSIONS_DIR)) {
    const dir = path.join(SESSIONS_DIR, shard);
    if (!shard.includes('.worktrees') || live.has(shard)) continue;
    for (const session of readdirSync(dir)) {
      if (!session.startsWith('session-')) continue;
      const dst = path.join(SESSIONS_ARCHIVE, shard, session);
      try {
        mkdirSync(path.dirname(dst), { recursive: true });
        renameSync(path.join(dir, session), dst);
        moved += 1;
      } catch { /* 单个搬不动不影响其它 */ }
    }
    try { if (!readdirSync(dir).length) rmdirSync(dir); } catch { /* 非空就算了 */ }
  }
  return moved;
}

// 每个工单最近一次 headless 跑在哪个会话里；只有限流/进程没起来这类环境噪声才复用它。
const ISSUE_SESSION = new Map();
// 免费档额度用尽（insufficient balance）后，这个工单在本进程里改走付费，避免整单判死。
const FORCE_PAID = new Set();
// 免费池不可用时的默认口径（2026-10-27 用户定）：挂起工单等人决定，不自动烧付费。
// 设 DSH_FREE_POOL_BLOCK=0 可退回旧的「自动切付费」行为。
const FREE_POOL_BLOCK = (process.env.DSH_FREE_POOL_BLOCK ?? '1') !== '0';
// 连续 0 token 的失败：多半是额度/鉴权/模型下线，而不是「这次改动写错了」。
// 2026-10-27 实测：报错文本被截断时（只剩「现在验证验收命令」），靠文本匹配抓不到 QUOTA，
// 于是同一个死模型又白跑两次。这里按「连续 2 次 0 token」兜底换档。
const ZERO_TOKEN_FAILS = new Map();
// 每个工单最近一次的原始输出（stdout+stderr），失败时把尾部打进 dispatch.log。
const LAST_RAW = new Map();
// 同一提交最多试几次自动 rebase。基线冲突现在能自动重算、源码冲突交给 agent，
// 所以失败几次多半是工具/网络问题，给到 5 次；同一个 sha 上的失败评论用来计数。
const REBASE_MAX_TRIES = Number(process.env.DSH_REBASE_MAX_TRIES ?? 5);
// 仅用于验证重试状态机：前 N 次尝试强制失败，不真正调模型
const DEBUG_FAIL = Number(process.env.DSH_DEBUG_FAIL_ATTEMPTS ?? 0);
const CONCURRENCY = Math.max(1, Number(process.env.DSH_CONCURRENCY ?? 2));
// 正在跑的任务数：用来判断「这个任务会不会和别的任务重叠」。
// modelscope 免费档必须串行（fm.py limits：并发 6 只剩 7/37），重叠时改走可并发的档。
let RUNNING_TASKS = 0;
const ONCE      = process.argv.includes('--once');
const ENSURE    = process.argv.includes('--ensure');
const SELF      = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DRY       = process.argv.includes('--dry-run');
// 无人值守 = 人不在，只能 fail-closed。默认关：不设 DSH_UNATTENDED=1（或 --unattended）时行为与以前完全一致。
// --unattended 是给计划任务用的：Windows 计划任务的动作里不方便设环境变量，直接带上参数即可。
const UNATTENDED = (process.env.DSH_UNATTENDED ?? '') === '1' || process.argv.includes('--unattended');
const PROBE_STALE = process.argv.includes('--probe-stale');
// --issue N：只跑这一单（Pass^3 真实工单用）。带上它时不再扫整个队列，也不在 --once 下补位常驻进程，
// 否则一次「单跑」会顺手拉起一个会和它抢任务的调度器。
const FORCE_ISSUE = (() => {
  const i = process.argv.indexOf('--issue');
  const raw = i >= 0 ? process.argv[i + 1] : '';
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
})();
const POOL_SNAPSHOT = process.argv.includes('--pool-snapshot');
// 运行态三件（--status / --pause / --resume）：纯本地读写，不进轮询。
const RUNTIME = parseRuntime(process.argv);
const REPOS_FILE = (() => {
  const i = process.argv.indexOf('--repos');
  return i > 0 ? process.argv[i + 1] ?? null : null;
})();
const INTERVAL  = Number(process.env.DSH_POLL_INTERVAL ?? 60) * 1000;

function gitEnv() {
  return { GIT_ASKPASS: ASKPASS, GIT_TOKEN: token(), GIT_TERMINAL_PROMPT: '0' };
}
// https 通道会间歇性不通（实测同一天里 10 次全通、8 次全失败两个极端）。仓库上挂了一把
// write 部署密钥，于是留一条走 ssh.github.com:443 的备用通道：两种协议独立，谁通走谁。
// GIT_SSH_COMMAND 会被 git 原样交给 shell，Windows 反斜杠会被吃掉（实测 `D:\\code\\.secrets\\ssh-git.sh`
// 变成 `D:code.secretsssh-git.sh: command not found`），所以这里统一转成正斜杠。
const posix = (p) => p.replace(/\\/g, '/');
const SSH_WRAPPER = posix(process.env.DSH_SSH_WRAPPER || path.join(SECRETS_DIR, 'ssh-git.sh'));
const SSH_REMOTE = `ssh://git@ssh.github.com:443/${REPO}.git`;
// 惰性构造：模块顶层一旦读 token 文件，CI（没有 .secrets）里 import 就会 ENOENT。
function sshEnv() { return { ...gitEnv(), GIT_SSH_COMMAND: SSH_WRAPPER, GIT_SSH_VARIANT: 'ssh' }; }

function networkError(r) {
  const t = `${r?.err ?? ''}${r?.out ?? ''}`;
  return /Failed to connect|Connection was reset|Recv failure|Could not resolve host|Connection timed out|early EOF/i.test(t);
}

// 随包运行时根目录：.../dependencies/node/bin/node.exe 上溯三级才是 dependencies。
// 上溯两级会落到 .../dependencies/node，PNPM_CLI 随之指向不存在的 node/pnpm/bin。
const INSTALL_DIR = process.env.DSH_INSTALL || path.join(HOME, 'AppData', 'Local', 'Programs', 'DeepSeek Harness');
const BUNDLE_DIR = process.env.DSH_BUNDLE_DIR || path.join(HOME, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies');
const PNPM_CLI = process.env.PNPM_CLI || path.join(BUNDLE_DIR, 'pnpm', 'bin', 'pnpm.cjs');
const FAIL_STORE = path.join(REPO_DIR, 'docs', 'failures.jsonl');

// 计划任务里的 PATH 不含 node/git；显式把当前 node 与 git 所在目录拼进去，
// 否则被调起的 headless agent 在 verify.sh 里跑 `node` 会 command not found。
const CHILD_PATH = [
  path.dirname(process.execPath),
  path.dirname(GIT),
  process.env.PATH,
].filter(Boolean).join(path.delimiter);

// 计划任务里 stdout 无处可去，必须自己落盘，否则无人值守跑完什么都看不到。
const LOG_DIR = process.env.DSH_LOG_DIR || path.join(REPO_DIR, '.logs');
// 换行常量：本文件里避免在模板字符串中写转义（历史上被脚本改坏过两次）。
const NL = String.fromCharCode(10);
const LOG_FILE = path.join(LOG_DIR, 'dispatch.log');
// v3 P1（docs/89 §3.1）：证据链单独一条 append-only JSONL，和运行日志分开——
// 日志会轮转覆盖，证据不能（链一断，所有已签的 witness 就作废了）。
const WITNESS_FILE = process.env.DSH_WITNESS_FILE || defaultChainFile(REPO_DIR);
// v3 P1 补（docs/89 §六-1）：ed25519 私钥只在调度器进程；存在则签发带签名并强制验签，
// 不存在则保持哈希链 L2（旧行为）。公钥与撤销清单在 governance/keys/（随仓库分发）。
const WITNESS_KEY = process.env.DSH_WITNESS_KEY || path.join(SECRETS_DIR, 'dispatch-ed25519.pem');
const WITNESS_KEY_ID = process.env.DSH_WITNESS_KEY_ID || 'dispatch-20261108';
const WITNESS_SIGNING = existsSync(WITNESS_KEY);
const WITNESS_KEYRING_DIR = process.env.DSH_KEYRING || path.join(REPO_DIR, 'governance', 'keys');
const WITNESS_KEYS = WITNESS_SIGNING && existsSync(WITNESS_KEYRING_DIR) ? loadKeyring(WITNESS_KEYRING_DIR) : null;
const LANE_STATS_FILE = defaultLaneStatsFile(REPO_DIR);
// 进程启动时从落盘记录恢复样本；之后每张单追加一条。重启不清零（目标 ≤5% 才有意义）。
const LANE_RECORDS = loadLaneStats(LANE_STATS_FILE);
// 本地时间带日期：旧格式是 UTC 的 [HH:MM:SS]、不带日期，跨天翻日志会把昨天的行当成「刚才」。
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
// `--status` 声明了「只读」：它已经拿到锁就不会写、不调 API，但底层函数（比如
// todaySpendCny）会顺手 log()，而 log 会建目录、append、甚至轮转覆盖 .log.1。
// 只读命令期间把写盘那一半关掉，屏幕输出照旧。
let LOG_READONLY = false;
const log = (m) => {
  const line = `[${stamp()}] ${m}`;
  console.log(line);
  if (LOG_READONLY) return;
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch { /* 日志失败不能影响主流程 */ }
};

// ---------- 事件通知 ----------
// 无人值守时，「任务失败」「重投用完需要人工接手」「今日花费到顶」是三种必须让人知道的事。
// 落两处：events.jsonl（digest 次日读）+ Windows 通知（当场弹）。
// 弹窗失败只记一行：通知挂掉不该让调度器停摆（和日志同一个口径）。
const EVENTS_FILE = process.env.DSH_EVENTS_LOG || path.join(homedir(), '.dsh', 'coord', 'log', 'events.jsonl');
// 池子快照落这里（digest 读趋势用）：默认与 events.jsonl 同目录。
const POOL_SNAPSHOT_FILE = process.env.DSH_POOL_SNAPSHOT_LOG || path.join(homedir(), '.dsh', 'coord', 'log', 'pool-snapshot.jsonl');
const NOTIFY_OFF = (process.env.DSH_NOTIFY ?? '1') === '0';
// 远端出口：人不在机器前时 Toast 等于没发（2026-10-28 架构评审 P0-3）。
// 没配就是空串，postWebhook 直接返回 skipped，行为与以前一致。
const NOTIFY_WEBHOOK = process.env.DSH_NOTIFY_WEBHOOK || '';
let WEBHOOK_WARNED = false;

// toast 要一个已注册的 AppUserModelId 才会真的弹；注册只是写 HKCU，幂等且无副作用。
function ensureAumid() {
  if (spawnSync('reg', regQueryArgs(), { timeout: 5000, stdio: 'ignore', windowsHide: true }).status === 0) return true;
  return spawnSync('reg', regAddArgs(), { timeout: 5000, stdio: 'ignore', windowsHide: true }).status === 0;
}

function notifyEvent({ kind, issue, why, cny }) {
  if (DRY) return;
  const rec = eventRecord({ kind, issue, why, cny });
  try {
    appendEvent(EVENTS_FILE, rec);
  } catch (e) {
    log(`[notify] 事件落盘失败：${e.message}`);
  }
  if (NOTIFY_WEBHOOK) {
    // 不 await：通知是旁路，慢端点不能拖住调度循环。失败只记一行。
    void postWebhook(NOTIFY_WEBHOOK, rec)
      .then((r) => {
        if (r.ok) log(`[notify] webhook 已投递（${r.status ?? 'ok'}）`);
        else if (!WEBHOOK_WARNED) {
          WEBHOOK_WARNED = true;
          log(`[notify] ⚠ webhook 投递失败（后续同类失败不再重复记）：${r.error ?? r.skipped ?? r.status}`);
        }
      })
      .catch(() => {});
  }
  if (NOTIFY_OFF) return;
  try {
    const { title, message } = toastText({ kind, issue, why });
    const script = writeToastScript(path.join(LOG_DIR, 'notify-toast.ps1'), { title, message });
    const aumid = ensureAumid();
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      timeout: 15000,
      stdio: 'ignore',
      windowsHide: true,
    });
    const seen = spawnSync('reg', ['query', settingsKey()], { timeout: 5000, stdio: 'ignore', windowsHide: true });
    log(`[notify] 已发系统通知：${title}（AUMID ${aumid ? '已注册' : '注册失败'}，送达 ${seen.status === 0 ? '确认' : '未确认'}）`);
  } catch (e) {
    log(`[notify] 弹窗失败（不影响任务）：${e.message}`);
  }
}


// 每次尝试都会落一份 prompt 和一份完整输出；无人值守跑几天就是几千个文件。
// 只清理「目录里看起来像尝试产物」的文件，别的（锁、轮转后的 .1）一律不碰。
const LOG_RETENTION_DAYS = Number(process.env.DSH_LOG_RETENTION_DAYS || 7);
function pruneLogs() {
  let removed = 0;
  try {
    if (!existsSync(LOG_DIR)) return 0;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 3600 * 1000;
    for (const name of readdirSync(LOG_DIR)) {
      if (!/^issue-\d+-attempt-\d+\.(log|prompt\.md)$/.test(name)) continue;
      const p = path.join(LOG_DIR, name);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed += 1; }
      } catch { /* 单个文件删不掉不影响其它 */ }
    }
  } catch { /* 目录读不了就算了 */ }
  return removed;
}

// ---------- 基础设施 ----------

async function api(method, p, body) {
  // 公开出口（issue 评论 / PR body）先脱敏：本机绝对路径与 token 形状不该跟着 agent 输出
  // 发到公开页面。打码只做在这一处，新增的评论点不用各自记得处理（P1-7，issue #242）。
  const payload = redactPublicPayload(method, p, body);
  const r = await fetch(`https://api.github.com${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-dispatch',
      'Content-Type': 'application/json',
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok && r.status !== 404) {
    throw new Error(`${method} ${p} -> ${r.status} ${String(text).slice(0, 300)}`);
  }
  return { status: r.status, data };
}

// ---------- 仓库标签 ----------
// GitHub 给 issue 打一个不存在的标签是**静默丢弃**的（不报错、issue 上也不多东西）。
// 2026-10-28 实测：仓库里没有 agent:blocked:manual，giveup 分支打上去看起来成功，
// 人从标签上却看不出「这张单要人工接手」。所以启动时先补齐一次。
// 失败只记一行日志、不重试也不阻塞轮询：标签管理要 issues:write，权限不足时任务本身照跑。
let LABELS_ENSURED = false;

async function ensureLabels() {
  if (LABELS_ENSURED) return [];
  let existing = [];
  try {
    const r = await api('GET', `/repos/${REPO}/labels?per_page=100`);
    existing = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    log(`[labels] 读不到现有标签，跳过补齐：${e.message}`);
    return [];
  }
  const missing = missingLabels(existing);
  if (!missing.length) {
    LABELS_ENSURED = true;
    return [];
  }
  if (DRY) {
    log(`[dry-run] [labels] 缺 ${missing.length} 个标签，不会真的建：${formatLabelList(missing)}`);
    return [];
  }
  const created = [];
  for (const name of missing) {
    try {
      await api('POST', `/repos/${REPO}/labels`, labelPayload(name));
      created.push(name);
    } catch (e) {
      // 409/422 = 其实已经有了（列表分页没抓到），不是错误，不用刷日志
      if (!/-> (409|422)/.test(e.message)) log(`[labels] 建 ${name} 失败：${e.message}`);
    }
  }
  if (created.length) log(`[labels] 补齐 ${created.length} 个缺失标签：${formatLabelList(created)}`);
  LABELS_ENSURED = true;
  return created;
}

function run(cmd, args, { cwd, env, timeout, input, clean } = {}) {
  return new Promise((resolve) => {
    // clean=true 时完全不用父进程的 env：给 agent 的子进程必须走这条，
    // 否则调度器环境里的凭据（GIT_TOKEN / 各种 API key）会随环境泄漏给模型。
    const p = spawn(cmd, args, { cwd, env: clean ? { ...env } : { ...process.env, ...env }, windowsHide: true });
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    let out = '', err = '';
    let timedOut = false;
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    // spawn 失败（bash 都没起来）才是环境；被 SIGKILL 的超时是「这单卡住了」，不是环境。
    const timer = timeout
      ? setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeout)
      : null;
    p.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, spawnError: true, out, err: err + e.message }); });
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, timedOut, out, err });
    });
  });
}

// 本机全局配置把 https://github.com/ 重写成 ghfast.top 镜像（fetch 加速），
// 而全局 credential.helper=manager 给 ghfast.top 的凭据是错的，实测 fetch 100% 报
// `remote: Repository not found.`。统一禁用 GCM、只让 GIT_ASKPASS 供凭据后 3/3 成功。
const git = (args, opts = {}) =>
  run(GIT, ['-c', 'credential.helper=', ...args], {
    ...opts,
    cwd: opts.cwd ?? REPO_DIR,
    env: { ...gitEnv(), ...(opts.env ?? {}) },
  });

// github.com:443 整晚会间歇性连不上（2026-10-25 实测：同一分钟 api.github.com 200、
// github.com 超时或 Connection was reset）。fetch 挂在这里是链路抖，不是仓库或凭据的问题，
// 所以任何「一定要拿到最新 main」的 fetch 都走这个退避（约 95 秒窗口）。
const FETCH_BACKOFF_MS = [5000, 10000, 20000, 30000, 30000];

async function fetchWithRetry(args = ['origin', '--quiet'], cwd = REPO_DIR) {
  let last = null;
  for (let i = 0; i <= FETCH_BACKOFF_MS.length; i += 1) {
    last = await git(['fetch', ...args], { cwd });
    if (last.code === 0) return last;
    if (i < FETCH_BACKOFF_MS.length) await new Promise((r) => setTimeout(r, FETCH_BACKOFF_MS[i]));
  }
  if (networkError(last)) {
    // 换协议再试：SSH 端点与 https 走不同的主机与端口，抖动很少同时命中两边。
    log('[net] https 取不到，改走 SSH 端点');
    const viaSsh = await run(GIT, ['-c', 'credential.helper=', 'fetch', SSH_REMOTE,
      '+refs/heads/*:refs/remotes/origin/*'], { cwd, env: sshEnv() });
    if (viaSsh.code === 0) return viaSsh;
    last = viaSsh;
  }
  throw new Error(`git fetch 失败（退避重试 ${FETCH_BACKOFF_MS.length + 1} 次 + SSH 端点）: ${last.err.trim().slice(0, 200)}`);
}

// ---------- 单实例锁 ----------
// 计划任务每 5 分钟一轮，人（或 agent）也可能手动跑一次；两个进程会抢同一个
// worktree 路径和分支，表现为「agent 未产生任何改动」这种假故障。用文件锁串行化。
const LOCK_FILE = path.join(LOG_DIR, 'dispatch.lock');
// once 口径：领到单后要干到超时才回来，这期间心跳是停的，只能按「超时 + 10 分钟」判。
const LOCK_STALE_MS = TIMEOUT + 10 * 60 * 1000;
// serve 口径：每轮都刷心跳，停 3 分钟就是卡死/被杀（原来是 40 分钟才接管，见 ci/lock-policy.mjs）。
const LOCK_BEAT_STALE_MS = Number(process.env.DSH_LOCK_BEAT_STALE_MS ?? DEFAULT_BEAT_STALE_MS);
// 心跳单独用一个定时器：pollOnce 里跑单可能几十分钟，而轮询循环的心跳只在两轮之间刷。
// 单在跑时锁的 at 不动 → 3 分钟后别的进程（计划任务 / --ensure）判「陈旧」接管，正在跑的单被
// 孤儿化、issue 被重新领取（2026-11-07 00:31 实测 #95 就是这样丢的）。间隔要小于判陈旧阈值。
const LOCK_BEAT_INTERVAL_MS = Number(process.env.DSH_LOCK_BEAT_INTERVAL_MS ?? 30_000);
const LOCK_MODE = ONCE ? 'once' : 'serve';

// 谁在跑：只有「进程还活着且锁不算太旧」才算占用，否则视为陈旧可接管。
function lockHolder() {
  let cur = null;
  try { cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
  if (!cur?.pid) return null;
  let alive = false;
  // EPERM 的意思是「进程在，但没权限发信号」，不是「死了」：Windows 上跨用户或提权的进程
  // 就是这种返回值。把它当死会误接管一个还在心跳的常驻进程（2026-10-28 实测：新一轮
  // --ensure 接管了 1 分钟前才刷过心跳的 pid）。真死是 ESRCH。
  try { process.kill(cur.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  const age = cur.at ? Date.now() - Date.parse(cur.at) : Infinity;
  const held = lockHeld({ alive, ageMs: age, mode: cur.mode, beatStaleMs: LOCK_BEAT_STALE_MS, staleMs: LOCK_STALE_MS });
  return held ? cur : null;
}

function ownsLock() {
  try { return JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid === process.pid; } catch { return false; }
}

// `--status` 用的只读视角：锁文件里写了什么、那个 pid 现在死没死、心跳是否还算新鲜。
// 故意不复用 lockHolder()：它只回答「能不能接管」，这里还要回答「心跳是不是早停了」。
function statusLock() {
  let cur = null;
  try { cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch { return null; }
  if (!cur?.pid) return null;
  let alive = false;
  try { process.kill(cur.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  const atOk = cur.at ? Number.isFinite(Date.parse(cur.at)) : false;
  // `at` 解析不出来时 age = NaN，`lockPolicy` 会把 NaN 当「心跳陈旧」——那是猜的。
  // 这里显式记成「时间未知」，输出里也说清楚，别让一个活着的锁看起来像死了。
  const age = atOk ? Date.now() - Date.parse(cur.at) : Infinity;
  const held = lockHeld({ alive, ageMs: age, mode: cur.mode, beatStaleMs: LOCK_BEAT_STALE_MS, staleMs: LOCK_STALE_MS });
  return { pid: cur.pid, mode: cur.mode, at: cur.at, atUnknown: !atOk, alive, beatFresh: held, ageMs: age };
}

// 最近 n 条事件的 kind，只给 --status 看趋势；事件文件破损时静默为空（体检不该因它报错）。
function recentKinds(n) {
  try {
    const rows = readFileSync(EVENTS_FILE, 'utf8').split(NL).filter(Boolean).slice(-n);
    return rows.map((line) => {
      try { const e = JSON.parse(line); const t = String(e.at ?? e.ts ?? ''); return `${e.kind ?? '?'}@${t.slice(5, 16).replace('T', ' ')}`; } catch { return '坏行'; }
    });
  } catch { return []; }
}

function acquireLock() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const me = lockPayload({ pid: process.pid, at: new Date().toISOString(), mode: LOCK_MODE });
  const write = () => writeFileSync(LOCK_FILE, JSON.stringify(me));
  // 只有锁还是自己写的那份才删。常驻进程被接管后退出时若无条件 unlink，会把新持有者的锁删掉，
  // 第三个进程再「接管」一次——2026-10-25 07:17 实测就是这样滚成「谁都没有锁、也没有常驻进程」。
  const release = () => {
    try {
      if (JSON.parse(readFileSync(LOCK_FILE, 'utf8')).pid !== process.pid) return;
      unlinkSync(LOCK_FILE);
    } catch { /* 已经没了 */ }
  };

  try {
    writeFileSync(LOCK_FILE, JSON.stringify(me), { flag: 'wx' });
    return { ok: true, release };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  if (lockHolder()) return { ok: false, holder: lockHolder() };

  let cur = null;
  try { cur = JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch { cur = null; }
  log(`接管陈旧锁（pid=${cur?.pid ?? '?'} 起于 ${cur?.at ?? '?'}）`);
  write();
  // 两个进程可能同时判「陈旧」并各写一份锁；写完必须回头确认赢的是自己，否则让位。
  if (!ownsLock()) {
    let other = null;
    try { other = JSON.parse(readFileSync(LOCK_FILE, 'utf8')); } catch { /* 读不到就让上面那次重试 */ }
    return { ok: false, holder: other ?? { pid: '?', at: '?' } };
  }
  return { ok: true, release };
}

// ---------- 并发原语 ----------

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// .git/worktrees 与 refs 不是并发安全的，worktree 的建删必须串行
let wtLock = Promise.resolve();
function locked(fn) {
  const p = wtLock.then(fn, fn);
  wtLock = p.then(() => {}, () => {});
  return p;
}

async function setupWorktree(branch, wt, baseRef) {
  return locked(async () => {
    await fetchWithRetry();
    await git(['worktree', 'remove', '--force', wt]);
    await git(['branch', '-D', branch]);
    const add = await git(['worktree', 'add', wt, '-b', branch, baseRef]);
    if (add.code !== 0) {
      // #229 对照表 #2：worktree add 失败会留下半建目录 / 已建分支，下一轮 setupWorktree 又因
      // 「目录已存在」「分支已占用」继续失败，把一次网络/参数错误放大成死循环。先按 git 登记
      // 状态回滚，git 不认的残留目录再手删；失败信息原样抛出（重试策略仍由调用方决定）。
      const rm = await git(['worktree', 'remove', '--force', wt]);
      const del = await git(['branch', '-D', branch]);
      if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
      log(`⚠ worktree add 失败，已清理残留（remove=${rm.code} branch=${del.code}）: ${add.err.trim().slice(0, 200)}`);
      throw new Error(`worktree add 失败: ${add.err.trim()}`);
    }
    // 红线执行层（P0-2）：打开仓库里的钩子目录。规则在 ci/precommit.mjs，
    // agent 想「不读 AGENTS.md 硬推」时会被钩子直接挡在 commit 之前。
    const hooks = await git(['config', 'core.hooksPath', '.githooks']);
    if (hooks.code !== 0) log(`⚠ 没能启用 pre-commit 钩子：${hooks.err.trim().slice(0, 200)}`);
  });
}

// ---------- Issue 解析 ----------

function parseSections(body) {
  const out = {};
  for (const part of String(body ?? '').split(/^### /m).slice(1)) {
    const nl = part.indexOf('\n');
    if (nl < 0) continue;
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}

function pick(sections, ...keys) {
  for (const [k, v] of Object.entries(sections)) {
    if (keys.some((key) => k.includes(key))) return v;
  }
  return '';
}

// issue 里的验收命令几乎总是包在 ``` 代码块里。直接把围栏当命令跑，bash 会把
// “VERDICT:” 当成命令名（实测 `/usr/bin/bash: line 10: VERDICT:: command not found`），
// 于是明明验收通过却被判成「没打印 VERDICT 行」。这里只剥最外层的一对围栏。
function stripFence(text) {
  return String(text ?? '')
    .replace(/^\s*```[a-zA-Z0-9_-]*[ \t]*\r?\n/, '')
    .replace(/\r?\n?\s*```\s*$/, '')
    .trim();
}

// 规则与计划物化（P0-3）：把 issue 的三段验收变成工作区里的一页 PLAN.md。
// agent 读文件比读 5 KB 提示词更可靠，人工也能在 worktree 里直接对照。
function writePlan(wt, { n, title, goal, acceptance, constraints, cmds }) {
  const body = [
    `# issue #${n}：${title}`,
    '',
    '这份文件由调度器按 issue 生成，是本次任务的唯一验收清单。',
    '',
    '## 目标',
    goal.trim() || '（issue 没写目标）',
    '',
    '## 验收标准',
    acceptance.trim() || '（issue 没写验收标准）',
    '',
    '## 验收命令（调度器会自己跑一遍，必须 exit 0）',
    cmds.trim()
      ? ['```', cmds.trim(), '```'].join(NL)
      : '（没有提供验收命令——本工单不允许进交付流程）',
    '',
    '## 约束',
    constraints.trim() || '（issue 没写约束）',
    '',
    '## 硬性红线（pre-commit 钩子会挡）',
    '- 不许删/改已有测试与断言来凑绿；基线必须 `bash scripts/verify.sh --bless` 同步。',
    '- 不许改 `.github/`、`.githooks/`、`scripts/`、`ci/`（需要时在 issue 打 `allow:gate` 并人工复核）；',
    '- 例外：`scripts/test-baseline.txt`、`scripts/assert-baseline.txt` 必须同 PR `--bless` 同步（它们是数据不是代码）。',
    '- 不许留调试占位符、断点语句、只跑单个用例的标记或调试日志（评审层会逐条列出具体行）。',
    '- 不许加依赖；一 PR 一个垂直切片。',
  ].join(NL);
  try {
    const dir = path.join(wt, '.dsh');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'PLAN.md'), `${body}${NL}`);
    // 光靠 .git/info/exclude 不够稳：#62 的 agent 一进来就看到 .dsh/PLAN.md 是「未跟踪改动」，
    // 还在总结里专门解释了一遍。目录内再放一个 .gitignore，让任何 git 状态都看不见它。
    writeFileSync(path.join(dir, '.gitignore'), `*${NL}`);
    // 不污染 PR：把它们排除在工作区之外（worktree 共享同一份 .git/info/exclude）。
    const exclude = run(GIT, ['rev-parse', '--git-path', 'info/exclude'], { cwd: wt });
    if (exclude.code === 0) {
      const file = path.resolve(wt, exclude.out.trim());
      const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (!cur.includes('.dsh/')) appendFileSync(file, `${cur.endsWith(NL) || !cur ? '' : NL}.dsh/${NL}`);
    }
  } catch (e) {
    log(`⚠ 写 PLAN.md 失败（不影响任务）：${e.message}`);
  }
}

function buildPrompt({ n, title, goal, acceptance, constraints, attempt = 1, priorFailure = '', readonly = false }) {
  const readonlyBlock = readonly
    ? `\n## 只读任务（最高优先级）\n这是只读工单：只做调查/验证并给出结论，**绝对不要创建、修改或删除任何文件**，包括临时脚本和 wrapper。\n- 只读检查用 \`node -e\` 或 \`grep\` 完成，不落盘；\n- 结论写进最终回答（文件路径 + 行号 + 事实），调度器会把它贴到 issue 上；\n- 不要为了「产生改动」而提交或写文件。\n`
    : '';
  const retryBlock = priorFailure
    ? `\n## 上次失败原因（这是第 ${attempt} 次尝试，必须针对性修复，不要重复同样的错误）\n${String(priorFailure).slice(0, 3000)}\n`
    : '';
  // 失败指纹库命中时，把「同一个根因以前出现过」连同上次修法一起喂进去，
  // 避免换个工单又从零摸索。
  const known = priorFailure ? formatPriorFailures(priorFailure, FAIL_STORE) : '';
  const knownBlock = known
    ? `\n## 历史同类失败（调度器记忆库）\n${known}\n\n先确认这次的根因是否与上次一致；一致就直接照上次的修法，不要重新试错。\n`
    : '';
  // P2：Issue 正文（含标题）是不可信输入。三段内容一律进围栏，并在前面显式声明「以下为数据」；
  // 提示词层不是主防线，这里只保证正文无法提前闭栏、越不过下面的「## 硬性规则」。
  const safeTitle = String(title || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  return `你正在一个隔离的 git worktree 里工作。任务来自 GitHub Issue #${n}：${safeTitle}
${retryBlock}${knownBlock}${readonlyBlock}
${FENCE_DECLARATION}

## 目标
${fenceUntrusted(goal, { label: '目标' })}

## 验收标准（必须全部满足）
${fenceUntrusted(acceptance, { label: '验收' })}

## 约束
${fenceUntrusted(constraints || '（无额外约束）', { label: '约束' })}

## 硬性规则
1. 先读仓库根目录的 AGENTS.md，遵守其中的约定。
2. 完成后必须运行 \`bash scripts/verify.sh\` 并确保通过（lint + 测试 + 构建 + 打包）。
3. **不要执行 git commit / git push / gh 命令** —— 调度器会负责提交、推送和开 PR。
4. 不要修改 .github/workflows/*，不要新增依赖，不要为了过测试而修改或删除已有测试断言。
5. 只有验收标准全部满足才算完成；做不到就停下来说明卡在哪，不要假装完成。

现在开始。`;
}

// ---------- 单个任务 ----------

async function failTask(issue, reason) {
  const n = issue.number;
  const r = String(reason).slice(0, 2000);
  log(`[issue #${n}] FAILED: ${r.split('\n')[0].slice(0, 200)}`);
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
  // 必须摘掉 agent:ready，否则下一轮轮询会把失败的 issue 再次领取
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:ready')}`).catch(() => {});
  await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:failed'] }).catch(() => {});
  await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
    body: `❌ 调度器执行失败：\n\n\`\`\`\n${r}\n\`\`\`\n\n处理完后去掉 \`agent:failed\`、重新加 \`agent:ready\` 即可重试。`,
  }).catch(() => {});
  notifyEvent({ kind: 'failed', issue: n, why: r.split('\n')[0].slice(0, 120) });
}

// 缺东西、没法开工 → 挂起为 needs-info，等人补（2026-11-06 P1）。
// 与 failTask 的区别：不耗重试预算、不发「任务失败」告警、会发邮件；
// 复活方式与 failTask 一致（改完 issue 去掉 needs-info、重加 agent:ready）。
const NOTIFY_MAIL = process.env.DSH_NOTIFY_MAIL || 'D:/dsh/default-workspace/tools/notify-mail.py';

async function sendInfoMail(issue, reason) {
  if (process.env.DSH_NEEDS_INFO_MAIL === '0') return;
  const { subject, body } = buildNeedsInfoMail({ number: issue.number, title: issue.title, reason, repo: REPO });
  try {
    const r = await run('python', [NOTIFY_MAIL, '--subject', subject, '--body', body], { timeout: 30000 });
    if (r.code === 0) log(`[issue #${issue.number}] needs-info 邮件已发（${subject}）`);
    else log(`⚠ needs-info 邮件未发（exit ${r.code}）：${(r.out + r.err).trim().slice(-300)}`);
  } catch (e) {
    // 邮件是 best-effort：配置缺失/网络不通都不该把工单判死，评论与标签已经落地。
    log(`⚠ needs-info 邮件异常（不影响挂起）：${e.message}`);
  }
}

async function askInfo(issue, reason) {
  const n = issue.number;
  const r = String(reason).slice(0, 2000);
  log(`[issue #${n}] NEEDS-INFO: ${r.split('\n')[0].slice(0, 200)}`);
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
  // 必须摘掉 agent:ready：否则下一轮轮询会原地重领、每分钟重复提问一次。
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:ready')}`).catch(() => {});
  await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: [NEEDS_INFO_LABEL] }).catch(() => {});
  await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
    body: buildNeedsInfoComment({ number: n, title: issue.title, reason: r }),
  }).catch(() => {});
  await sendInfoMail(issue, r);
  notifyEvent({ kind: 'needs-info', issue: n, why: r.split('\n')[0].slice(0, 120) });
}

// 环境/机器问题导致的人工挂起：与 blockTask 的区别是**不自动恢复**。
// blockTask 是「免费池暂时不可用」，recoverBlocked 会在池子探活恢复后把单子放回 ready；
// 环境失败（沙箱不让 spawn）恢复与否取决于人，自动重投只会每 5/10/20 分钟空转一轮。
// 所以这里写 gaveUp:true 的本地记录 + agent:blocked:manual，等人处理。
async function blockManual(issue, why, detail) {
  const n = issue.number;
  const d = String(detail || '').slice(0, 1500);
  log(`[issue #${n}] ${why}，工单挂起为 agent:blocked:manual（不自动重投）`);
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:ready')}`).catch(() => {});
  await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:blocked', 'agent:blocked:manual'] }).catch(() => {});
  try {
    const state = readBlockedState();
    state[n] = { ...initialEntry({ now: Date.now(), why, requeues: state[n]?.requeues ?? 0, backoff: REQUEUE_BACKOFF }), gaveUp: true, gaveUpAt: new Date().toISOString() };
    writeBlockedState(state);
  } catch (e) { log(`⚠ 记 blocked-state 失败（不影响挂起）：${e.message}`); }
  const fenced = d ? ['```', d, '```'].join(NL) : '';
  await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
    body: [
      `⛔ ${why}：这不是这张单写错了，调度器没有替你重试到底（环境问题重试不消耗重试预算）。`,
      '',
      fenced,
      '**怎么继续**：',
      '- 先把机器弄能跑：在**宿主进程**（不是受限沙箱）里跑一遍 `bash scripts/verify.sh`，绿了再继续；',
      '- 去掉 `agent:blocked` 与 `agent:blocked:manual`、重新打 `agent:ready`（本地挂起记录会一并重置）；',
      '- 环境限制不该靠改测试绕过去：`scripts/verify.sh` 在跑不了子进程时会 `exit 78` 并说明原因。',
    ].filter(Boolean).join(NL),
  }).catch(() => {});
  notifyEvent({ kind: 'blocked-manual', issue: n, why: String(why).slice(0, 120) });
}

async function blockTask(issue, why, detail) {
  const n = issue.number;
  const d = String(detail || '').slice(0, 1500);
  log(`[issue #${n}] 免费池不可用（${why}），工单挂起为 agent:blocked（不自动烧付费）`);
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
  await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:ready')}`).catch(() => {});
  await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:blocked'] }).catch(() => {});
  // 本地记一份挂起状态：自动恢复靠它算退避与重投次数（重投次数要跨次继承，
  // 否则池子抖一下就变成无限重跑）。
  try {
    const state = readBlockedState();
    state[n] = initialEntry({ now: Date.now(), why, requeues: state[n]?.requeues ?? 0, backoff: REQUEUE_BACKOFF });
    writeBlockedState(state);
  } catch (e) { log(`⚠ 记 blocked-state 失败（不影响挂起）：${e.message}`); }
  const fenced = d ? ['```', d, '```'].join(NL) : '';
  const body = [
    `⏸ 免费池暂时不可用（${why}），调度器没有替你改烧付费，先把这张单挂起。`,
    '',
    fenced,
    '**怎么继续**：',
    `- 大部分情况不用管：调度器会按退避（5/10/20/40/60 分钟）探活免费池，恢复后自动把单放回 \`agent:ready\`，最多自动重投 ${MAX_REQUEUE} 次，用完后会打 \`agent:blocked:manual\` 停下等人；`,
    '- 想立刻重试：等免费池好了（`python ~/.dsh/tools/free-models/fm.py stats --json` 看 ok 与额度），手动去掉 `agent:blocked`、重新打 `agent:ready`；',
    '- 或者这张单可以花付费的钱：额外打 `model:paid` 再打 `agent:ready`，调度器会走 `deepseek-flash`；',
    '- 想彻底关掉自动重投：调度器环境变量 `DSH_BLOCKED_AUTO_REQUEUE=0`；想恢复旧的「自动切付费」行为：`DSH_FREE_POOL_BLOCK=0`（两者独立）。',
  ].filter(Boolean).join(NL);
  await api('POST', `/repos/${REPO}/issues/${n}/comments`, { body }).catch(() => {});
  try { recordFailure({ text: `free-pool: ${why}`, issue: n, attempt: 0, reason: why }, FAIL_STORE); } catch { /* 记账失败不影响挂起 */ }
}

// ---------- agent:blocked 自动恢复 ----------
// 「免费池不可用 → 挂起等人」在无人值守时有个死角：池子半夜恢复了，单子还躺在 blocked 里。
// 这里补一层：按退避探活，恢复就把工单放回 agent:ready 重跑；重投有上限，池子抖动不会无限循环。
// 判据（何时再试 / 何时放弃）在 blocked-recovery.mjs 里做纯函数 + 单测，这里只做网络动作。
const BLOCKED_STATE_FILE = path.join(LOG_DIR, 'blocked-state.json');
const AUTO_REQUEUE = (process.env.DSH_BLOCKED_AUTO_REQUEUE ?? '1') !== '0';
const MAX_REQUEUE = Math.max(1, Number(process.env.DSH_BLOCKED_MAX_REQUEUE ?? MAX_AUTO_REQUEUE));
const REQUEUE_BACKOFF = parseBackoff(process.env.DSH_BLOCKED_BACKOFF_MIN ?? '5,10,20,40,60');
// 探活结果缓存：一轮里挂着好几张单时，不要每张都跑一次 fm.py。
const POOL_PROBE_TTL_MS = Number(process.env.DSH_BLOCKED_PROBE_TTL_MS ?? 60000);
let POOL_PROBE = { at: 0, value: null };

function readBlockedState() {
  try {
    if (!existsSync(BLOCKED_STATE_FILE)) return {};
    const parsed = JSON.parse(readFileSync(BLOCKED_STATE_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function writeBlockedState(state) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    const tmp = `${BLOCKED_STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, BLOCKED_STATE_FILE);
  } catch (e) { log(`⚠ 写 blocked-state 失败：${e.message}`); }
}

// 免费池算「恢复了」的判据：fm.py 健康快照里至少一个 ok 模型。
// stale 不算（要重试/换档）、degraded/unknown/down 都不算——宁可多等一轮，
// 也不要在池子还没好的时候把工单投出去白跑一次任务。
function poolHealth({ now = Date.now(), ttl = POOL_PROBE_TTL_MS } = {}) {
  if (POOL_PROBE.value && now - POOL_PROBE.at < ttl) return POOL_PROBE.value;
  let value;
  try {
    const entries = Object.entries(registryStats(true) || {});
    if (!entries.length) {
      value = { ok: false, why: '读不到免费池快照（fm.py stats 不可用）' };
    } else {
      const counts = {};
      for (const [, v] of entries) {
        const s = String(v?.status ?? 'unknown');
        counts[s] = (counts[s] ?? 0) + 1;
      }
      const okCount = counts.ok ?? 0;
      value = okCount
        ? { ok: true, why: `${okCount}/${entries.length} 个模型 ok` }
        : { ok: false, why: `没有 ok 模型（${Object.entries(counts).map(([k, c]) => `${k} ${c}`).join('、')}）` };
    }
  } catch (e) {
    value = { ok: false, why: `探活失败：${e.message}` };
  }
  POOL_PROBE = { at: Date.now(), value };
  return value;
}

// 2026-11-08 用户裁决：新方案停用本地大模型。旧实现（本地槽位探活 + 缓存 + 开关）已整体删除——重投判据只剩云端通道。
// 等待是免费的，白跑一次不是；本地档残留会让重投重新依赖 Lemonade，所以不留开关。
async function requeueLane(issue, { now = Date.now() } = {}) {
  const cloud = poolHealth({ now });
  const labels = (Array.isArray(issue?.labels) ? issue.labels : []).map((l) => String(l?.name ?? l));
  const paid = labels.includes('model:paid');
  return decideRequeue({ paid, cloud });
}

async function recoverBlocked() {
  const now = Date.now();
  const state = pruneState(readBlockedState(), { now });
  if (!AUTO_REQUEUE) {
    writeBlockedState(state);
    return 0;
  }
  let issues = [];
  try {
    const { data } = await api('GET', `/repos/${REPO}/issues?labels=${encodeURIComponent('agent:blocked')}&state=open&per_page=50`);
    issues = (Array.isArray(data) ? data : []).filter((i) => !i.pull_request);
  } catch (e) {
    log(`[blocked] 查询挂起工单失败：${e.message}`);
    writeBlockedState(state);
    return 0;
  }
  // 本代进程第一次见到的挂起单（上一代挂起 / 手工打的 label）：从此刻开始计时，
  // 不继承任何重投计数——那一份可能属于完全不同的一次挂起。
  for (const issue of issues) {
    const n = issue.number;
    if (state[n]) continue;
    state[n] = initialEntry({ now, why: '无本地记录（可能是上一代进程挂起的）', backoff: REQUEUE_BACKOFF });
    log(`[blocked] #${n} 已挂起但没有本地记录，从现在开始计时（下次探活 ${state[n].nextProbeAt}）`);
  }
  const due = issues.filter((i) => isDue(state[i.number], now));
  if (!due.length) {
    writeBlockedState(state);
    return 0;
  }
  let requeued = 0;
  for (const issue of due) {
    const n = issue.number;
    // 每张单按自己的路由判一次（paid 看云端，其余看本地槽位）；探活结果有 60s 缓存，不会每张单都打网络。
    const lane = await requeueLane(issue, { now });
    const d = recoveryDecision({ entry: state[n], now, pool: lane, maxRequeue: MAX_REQUEUE, backoff: REQUEUE_BACKOFF });
    if (d.action === 'skip') continue;
    if (DRY) {
      log(`[dry-run] [blocked] #${n} would ${d.action}：${d.reason}`);
      continue;
    }
    state[n] = d.entry;
    if (d.action === 'wait') {
      log(`[blocked] #${n} ${d.reason}`);
      continue;
    }
    if (d.action === 'requeue') {
      await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:blocked')}`).catch(() => {});
      await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:ready'] }).catch(() => {});
      await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
        body: [
          `▶ 通道恢复了（${lane.why}），调度器自动把这张单放回 \`agent:ready\` 重跑。`,
          '',
          `自动重投 ${d.entry.requeues}/${MAX_REQUEUE} 次。再挂起会继续按退避探活；次数用完会打 \`agent:blocked:manual\` 停下等人。`,
        ].join(NL),
      }).catch(() => {});
      log(`[blocked] #${n} ${d.reason}，自动重投 agent:ready（第 ${d.entry.requeues}/${MAX_REQUEUE} 次）`);
      requeued += 1;
      continue;
    }
    // giveup：池子好了但重投次数用完。不再自动投，打标记 + 说清怎么接手。
    await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:blocked:manual'] }).catch(() => {});
    await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
      body: [
        `⛔ ${d.reason}。`,
        '',
        '**怎么接手**：',
        '- 先看这张单最后一次失败的评论/日志，判断是池子容量问题还是任务本身写不过；',
        '- 修好后去掉 `agent:blocked` 与 `agent:blocked:manual`、重新打 `agent:ready`（重投计数会重置）；',
        '- 这张单可以花钱的话：加 `model:paid` 走 `deepseek-flash`。',
      ].join(NL),
    }).catch(() => {});
    log(`[blocked] #${n} ${d.reason}`);
    notifyEvent({ kind: 'blocked-manual', issue: n, why: d.reason });
  }
  writeBlockedState(state);
  return requeued;
}

// ---------- 独立门禁 + 评审层 ----------
// agent 会声称自己跑过了 verify.sh。这里不信自述，调度器自己在同一个 worktree
// 里再跑一遍；红就是红，绿才有资格进下一步。

async function verifyWorktree(wt) {
  // v3 P2（docs/89 §3.1 line 53）：门禁在「候选树」上跑，不在 agent 的脏工作树里跑。
  // 候选树 = HEAD + 已跟踪改动 patch + 未跟踪新文件，门禁字节仍从 origin/main 覆盖。
  // 生成失败就 fail-closed——宁可拒单，也不拿「agent 改过的工作树」当裁判。
  let cand;
  try {
    const s4 = process.env.DSH_S4_EXEC !== '0';
    const root = s4 ? ensureCandidateRoot() : undefined;
    // 顺手清掉上次删不掉的候选树（>1h，避开并发在跑的那两棵）。
    if (root) {
      const sw = sweepCandidates(root);
      if (sw.removed.length) log(`[cleanup] 清掉残留候选树 ${sw.removed.length} 棵`);
      if (sw.kept.length) log(`[cleanup] 仍有 ${sw.kept.length} 棵残留候选树（下次再清）`);
    }
    cand = prepareCandidateTree({ repoDir: wt, gitBin: GIT, ...(root ? { root, prefix: 'cand-' } : {}) });
    if (s4) {
      // 先给「当前的自己」完全控制：候选树里的产物是低权用户建的，管理员组的 ACE 在
      // UAC 过滤令牌里是 deny-only，删不掉（EPERM）。见 gate-snapshot.mjs 的注释。
      const own = grantTreeForCurrentUser(cand.dir);
      if (!own.ok) {
        try { cand.cleanup(); } catch { /* ignore */ }
        return { ok: false, env: true, detail: `ENV_FAIL: 无法给调度器自己授予候选树权限（清理会失败）：${own.why}` };
      }
      // 授权失败就别硬着头皮以低权跑（那样只会得到一堆权限错误，还会被误判成"代码不合格"）。
      const g = grantDir(cand.dir, 'M');
      if (!g.ok) {
        try { cand.cleanup(); } catch { /* ignore */ }
        return { ok: false, env: true, detail: `ENV_FAIL: 无法给低权用户授予候选树权限（${g.why}）` };
      }
    }
  } catch (e) {
    return { ok: false, detail: `候选树生成失败（fail-closed，未执行工作树门禁）：${e.message}` };
  }
  try {
    let v;
    if (process.env.DSH_S4_EXEC !== '0') {
      const r = await runAsAgentCommand({ cmd: 'bash scripts/verify.sh', cwd: cand.dir, timeoutSec: 900, actor: 'gate' });
      if (!r.done) return { ok: false, env: true, detail: 'ENV_FAIL: 低权门禁通道不可用；拒绝用 Administrator 跑 agent 代码' };
      // 同验收侧：runner 自检失败（exit 2 且零输出）是环境问题，不是代码不合格。
      if (r.code === 2 && !String(r.out || '').trim()) {
        return { ok: false, env: true, detail: 'ENV_FAIL: 低权门禁通道内部错误（exit 2，无输出）' };
      }
      v = { code: r.code, out: r.out, err: '' };
    } else {
      log('[s4-warn] DSH_S4_EXEC=0：门禁改由 Administrator 执行（降权被关闭，仅限调试；不可用于对外仓）');
      v = await run(BASH, ['scripts/verify.sh'], {
        cwd: cand.dir, timeout: 15 * 60 * 1000,
        env: { PATH: CHILD_PATH, PNPM_CLI },
      });
    }
    if (v.code === 0) {
      // stdout 一起带回去：witness 的 stdout_sha256 要绑「这次门禁到底吐了什么」，
      // 只记 gate 字节哈希证明不了门禁的输出没有在记录前后被换掉。
      return { ok: true, gate_bytes_sha256: cand.gate.sha256, gate_ref: cand.gateRef, stdout: `${v.out}\n${v.err}` };
    }
    // 78 = EX_CONFIG：门禁自己判定「这台机器现在跑不了子进程」，不是代码问题。
    // code -1 / 带 error：连 bash 都没起来（PATH 错、WSL 抢了 bash.exe），同样是环境不是代码。
    // 记成普通失败会让同一张工单白烧三次重试预算（红线：环境失败不消耗重试预算）。
    if (Number(v.code) === 78 || v.spawnError === true) {
      const tail78 = `${v.out}\n${v.err}`.trim().split('\n').filter(Boolean).slice(-5).join('\n');
      const why = Number(v.code) === 78 ? '门禁在受限环境里无法启动子进程（exit 78）' : '门禁进程根本没起来（bash 不可用）';
      return { ok: false, env: true, detail: `ENV_FAIL: ${why}\n${tail78}`, raw: `${v.out}\n${v.err}` };
    }
    const tail = `${v.out}\n${v.err}`.trim().split('\n').filter(Boolean).slice(-25).join('\n');
    // 尾部为空时至少留下退出码：历史上出现过「门禁失败但日志只有冒号」的情况，无法判断是
    // 门禁自己退非零还是脚本根本没产出任何东西（现在两边都写清楚）。
    const body = tail || '（门禁没有任何输出）';
    return {
      ok: false,
      detail: `独立门禁未通过（调度器在候选树上跑的 bash scripts/verify.sh，不采信 agent 自述）：exit=${v.code}\n${body}`,
      // full output：first_error 归因要扫完整输出，不能只看尾部 25 行（TAP 的 not ok 行往往更靠前）。
      raw: `${v.out}\n${v.err}`,
    };
  } finally {
    // 临时物清不掉不能判任务失败：一次 EPERM 曾让「门禁全绿」的第 3 次尝试整单失败（#231）。
    const c = cand.cleanup();
    if (c && c.ok === false) log(`[s4-warn] 候选树清理失败（不影响本次判定，留待巡检）：${c.why}`);
  }
}

// 提交之后才能拿到 base...HEAD 的 diff，所以评审放在 commit 之后、push 之前。
function reviewAfterCommit(wt, base = 'origin/main', options = {}) {
  const r = reviewWorktree(wt, base, options);
  if (r.ok) return { ok: true, findings: r.findings };
  return { ok: false, detail: `评审层拒绝（改动未推送）：\n${formatFindings(r)}` };
}

async function runTask(issue, attempt = 1, priorFailure = '') {
  const n = issue.number;
  const tag = `[issue #${n}]${attempt > 1 ? `(第 ${attempt} 次)` : ''}`;
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  log(`${tag} 领取：${issue.title}`);

  // v3 P1（docs/89 §3.4）：lane 决定验证强度。没声明/冲突 → high-risk（fail-closed），
  // 并把决策写回 issue 标签：人能看到「机器按最严档处理了」，unknown-rate 也不会被静默洗掉。
  const lane = parseLane(labels);
  const lp = lanePolicy(lane.lane);
  recordLane(LANE_STATS_FILE, { issue: n, lane: lane.lane, unknown: lane.unknown, declared: lane.declared, why: lane.why });
  LANE_RECORDS.push({ unknown: lane.unknown });
  log(`${tag} ${formatLaneLine(lane, laneStats(LANE_RECORDS))}`);
  if (lane.unknown) {
    await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: [HIGH_RISK_LABEL] })
      .catch((e) => log(`${tag} ⚠ 回写 ${HIGH_RISK_LABEL} 失败（不影响任务）：${e.message}`));
  }

  const sections = parseSections(issue.body);
  const goal = pick(sections, '目标');
  const acceptance = pick(sections, '验收标准');
  const constraints = pick(sections, '约束');
  // 原始验收命令（可能带 ``` 围栏）：PLAN.md 里保留原样给人看，执行时再剥围栏。
  const acceptanceCmdsRaw = pick(sections, '验收命令');

  // 验收标准门禁：没有可执行验收标准就不启动
  if (!goal || !acceptance) {
    const why = '缺少「目标」或「验收标准（可执行）」章节，拒绝执行。请按 Issue 模板补充后重新打 agent:ready。';
    // 无人值守没人能当场补：挂 needs-info 发邮件，而不是打 agent:failed 冒充「跑过但失败」。
    if (UNATTENDED) return askInfo(issue, why);
    return failTask(issue, why);
  }

  // 无人值守拒单：必须在打 agent:working 之前，也不能等到跑完才判——验收命令是唯一裁判，
  // `echo ok` 这种「永远绿」的命令等于没有验收。放在这里逐单处理，不影响同轮其他任务。
  if (UNATTENDED) {
    const intake = checkUnattendedIntake({ acceptanceCmds: stripFence(acceptanceCmdsRaw), labels });
    if (!intake.ok) {
      return askInfo(issue, `无人值守拒单：${intake.reason}`);
    }
  }

  await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:working'] });

  const branch = `agent/issue-${n}`;
  const wt = path.join(WT_ROOT, `issue-${n}`);
  if (!existsSync(WT_ROOT)) mkdirSync(WT_ROOT, { recursive: true });

  let prevSession = null;
  let resumeId = '';
  // 付费档判定要跨 try/catch 用：catch 里的「免费额度用尽 → 改付费」要读它。
  // 2026-10-27 实测到一个真 bug：这两个曾用 const 声明在 try 里，catch 里一读就
  // ReferenceError: usePaid is not defined，于是降级分支从来没生效过（白跑两次）。
  let usePaid = false;
  let forcePaid = false;
  try {
    await setupWorktree(branch, wt, 'origin/main');
    writePlan(wt, { n: issue.number, title: issue.title, goal, acceptance, constraints, cmds: acceptanceCmdsRaw });

    // #236 P5.5：任务前给主仓拍一张快照（.git/info/exclude 的 sha256 + `git status` 条目）。
    // 任务后（提交成功时）再拍一张比对：只看 worktree 的 status 抓不到「agent 改 exclude
    // 把文件从 git status 里藏掉」和「主仓多出没放行的产物/凭据副本」这两类漂移。
    const driftBefore = await takeSnapshot({ repoDir: REPO_DIR, run, git: GIT });

    const mainBefore = (await git(['rev-parse', 'origin/main'])).out.trim();
    // 只读工单：查代码/审计类任务不该产生改动。提示词里先立规矩，
    // 否则 agent 会为了满足「必须有改动」的门禁去造 wrapper 脚本（PR #41 就是这样混出来的）。
    const readonly = (issue.labels ?? []).some((l) => l.name === 'readonly:ok');
    const prompt = buildPrompt({ n, title: issue.title, goal, acceptance, constraints, attempt, priorFailure, readonly });
    // 提示词落盘：重试时能直接看清调度器到底喂了 agent 什么（记忆库有没有生效）。
    try {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(path.join(LOG_DIR, `issue-${n}-attempt-${attempt}.prompt.md`), prompt);
    } catch { /* 日志写不了不影响任务本身 */ }

    if (DEBUG_FAIL && attempt <= DEBUG_FAIL) {
      throw new Error(`[debug] 强制第 ${attempt} 次尝试失败（DSH_DEBUG_FAIL_ATTEMPTS=${DEBUG_FAIL}）`);
    }

    // issue 打了 model:strong 就用强模型路由；复杂任务用 29B 容易漏改
    // 第一次用便宜模型，失败后升级：29B 在长推理任务上会撞 TPM 限流而停在计划阶段，
    // 与其让同一个弱模型重试三次，不如第二次就换 DeepSeek-V4.1-Flash。
    const forceStrong = (issue.labels ?? []).some((l) => l.name === 'model:strong');
    const useStrong = forceStrong || attempt > 1;
    // 改门禁脚本默认被评审层阻断，issue 打 allow:gate 才放行（人工在 issue 上表态）
    const allowGate = (issue.labels ?? []).some((l) => l.name === 'allow:gate');
    const runEnv = { PATH: CHILD_PATH };
    // 环境噪声（限流 / 进程没起来）时接着上一次的会话跑：省一次冷启动上下文，
    // 也不会在 ~/.dsh/sessions 下再堆一个目录。逻辑失败不复用，让它干净地重新想一遍。
    prevSession = ISSUE_SESSION.get(n);
    resumeId = prevSession && (prevSession.kind === 'llm-rate-limit' || prevSession.kind === 'headless-crash') ? prevSession.id : '';
    // 显式给空串：否则调度器进程自己环境里的 DSH_SESSION_ID 会漏给 agent
    // （2026-10-27 实测：继承来的旧会话跑到一半就报「preset standard 不能被一次性 runner 组合」）。
    runEnv.DSH_SESSION_ID = resumeId || '';
    // 只有调度器在续跑同一个会话时才允许入口复用 session id；否则入口会拒绝被继承来的 id。
    runEnv.DSH_HEADLESS_RESUME = resumeId ? '1' : '';
    if (useStrong && !S4_ON) runEnv.DSH_HEADLESS_PATCH = STRONG_PATCH;
    // 付费是最后手段，但有一个例外：并发。modelscope 免费档必须串行（并发 6 只剩 7/37），
    // 已经有任务在跑时这个任务必然重叠，硬用免费档会互相挤、最后一齐超时。
    // 这种情况下改走 deepseek-flash（并发 2500，空闲 1/4 元每百万 tokens，一单约 ¥0.1）。
    const forcePaidLabel = (issue.labels ?? []).some((l) => l.name === 'model:paid');
    const freeOnly = (issue.labels ?? []).some((l) => l.name === 'model:free');
    const overlap = RUNNING_TASKS > 1;
    const quotaPaid = FORCE_PAID.has(n);
    forcePaid = forcePaidLabel;
    usePaid = forcePaid || quotaPaid || (overlap && !freeOnly);
    // S4：真 key 留在调度器，低权 agent 只拿一次性 token（ci/llm-proxy.mjs）。
    // 代理起来后 patch 指向 127.0.0.1，任务结束即关；代理失败才退回「不给 patch」的 fail-closed。
    let taskProxy = null;
    if (S4_ON && (useStrong || usePaid)) {
      taskProxy = await startTaskProxy(usePaid ? 'paid' : 'strong', tag);
      if (taskProxy) {
        runEnv.DSH_HEADLESS_PATCH = taskProxy.patchFile;
        runEnv.DSH_PROXY_TOKEN = taskProxy.token;
        log(`${tag} 代理路由：${usePaid ? 'deepseek-flash（付费）' : '免费强档'}，真 key 不进 agent`);
      } else {
        log(`${tag} ⚠ 低权隔离：代理未起，本次不给 patch，入口按环境失败退出`);
      }
    }
    if (usePaid && !S4_ON) {
      runEnv.DSH_HEADLESS_PATCH = PAID_PATCH;
      if (forcePaid) log(`${tag} ⚠ 按 model:paid 使用付费模型（默认是免费池）`);
      if (quotaPaid) log(`${tag} ⚠ 免费档额度用尽，本单改用 deepseek-flash（付费）`);
      else log(`${tag} ⇄ 有其它任务在跑（免费档不能并发），本单改用 deepseek-flash（付费，约 ¥0.1/单）`);
    }
    // 只有显式升级（model:strong / model:paid 导致的 .secrets 路由）才允许入口注入真实凭据。
    // 默认档不再有本地路由（2026-11-08 停用本地大模型）：入口未收到 patch 就 fail-closed，
    // 由调度器把「没有可用模型路由」暴露为环境失败，而不是悄悄退回 Lemonade。
    // 非 S4 的 .secrets 路由才允许入口自己读凭据；S4 代理只用一次性 token，不注入凭据开关。
    if (runEnv.DSH_HEADLESS_PATCH && !S4_ON) runEnv.DSH_HEADLESS_ALLOW_CREDS = '1';

    const modelNote = useStrong ? (forceStrong ? ', model=strong' : ', model=strong(重试升级)') : '';
    log(`${tag} 启动 headless（cwd=${wt}${modelNote}）`);
    const t0 = Date.now();
    let r;
    try {
      r = await runHeadless(wt, prompt, runEnv, TIMEOUT);
    } finally {
      if (taskProxy) await taskProxy.close();
    }
    // 代理看到的上游 429 是限流证据：reason 里可能只有 agent-exit-1，这里补进 LAST_RAW，
    // 否则会被免费池判定误判成「额度耗尽」直接挂起（2026-11-08 #116/#119 实测）。
    const proxyStatus = taskProxy?.upstreamStatus?.();
    LAST_RAW.set(n, `${String(r.raw ?? r.out ?? '')}${proxyStatus >= 400 ? `\n[proxy] upstream ${proxyStatus}` : ''}`);
    if (r.usage && r.usage.totalTokens === 0) ZERO_TOKEN_FAILS.set(n, (ZERO_TOKEN_FAILS.get(n) ?? 0) + 1);
    else ZERO_TOKEN_FAILS.delete(n);
    const sessionId = sessionIdOf(r.raw);
    if (sessionId) ISSUE_SESSION.set(n, { id: sessionId, kind: '' });
    const secs = Math.round((Date.now() - t0) / 1000);
    const usage = r.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: 0 };
    const tail = (r.out || '').trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
    log(`${tag} headless 结束 exit=${r.code} ${secs}s ${tail ? '→ ' + tail : ''}`);
    // token 用量：headless profile 不装 cost-meter，账本里没有这些 run，只能靠 --json 事件流自己记。
    let taskCny = null;
    const billedModel = usePaid ? 'deepseek-flash' : (STRONG_MODEL_NAME || 'free-pool');
    // 计量要么准、要么明确记为「未计量」。以前 usage 缺失就一行都不写（跑过但账本上不存在），
    // 日闸因此系统性低估（2026-10-28 实测：39 行里 9 行 0 token，另有一批压根没行）。
    const unmetered = !(r.usage && r.usage.totalTokens > 0);
    if (r.usage && r.usage.steps) log(`${tag} 消耗 ${formatUsage(r.usage)}`);
    try {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      const cny = unmetered ? null : costCny(r.usage, billedModel);
      taskCny = cny;
      if (cny !== null && cny > 0) log(`${tag} 估算成本 ${formatCny(cny)}（${billedModel}，按官方价目表；缓存命中量未透出，按未命中计）`);
      if (unmetered) log(`${tag} ⚠ 本次没有 token 统计（cost-meter 没吐 usage）：记为未计量，日闸按 ${formatCny(UNMETERED_UNIT_CNY)}/次保守计入`);
      if (cny !== null && cny > TASK_MAX_CNY) {
        log(`${tag} ⚠ 单任务估算 ${formatCny(cny)} 超过上限 ${formatCny(TASK_MAX_CNY)}：本批次暂停领取新任务（DSH_TASK_MAX_CNY 可调）`);
        pauseClaim(`单任务估算 ${formatCny(cny)} 超过上限 ${formatCny(TASK_MAX_CNY)}`);
      }
      appendFileSync(
        path.join(LOG_DIR, 'usage.jsonl'),
        JSON.stringify({
          at: new Date().toISOString(), issue: n, attempt, model: billedModel, paid: usePaid, cny,
          ...(unmetered ? { unmetered: true } : {}),
          ...(r.usage ?? {}),
        }) + NL,
      );
    } catch { /* 记账失败不影响任务本身 */ }
    // 只留最后 3 行不够排障：完整输出落盘，事后能看清 agent 为什么什么都没做。
    try {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      writeFileSync(path.join(LOG_DIR, `issue-${n}-attempt-${attempt}.log`),
        `exit=${r.code} ${secs}s\n===== stdout =====\n${r.out}\n===== stderr =====\n${r.err}\n`);
    } catch { /* 落盘失败不影响主流程 */ }
    const outTail = ((r.err || '') + String.fromCharCode(10) + (r.out || '')).trim().split('\n').filter(Boolean).slice(-12).join('\n');
    // 重试后仍然是 NTSTATUS：进程根本没起来，别让它走进「验收」流程（那会报错误的原因）。
    if (Number(r.code) >= 0xC0000000) {
      throw new Error(`[headless] headless-crash｜进程在启动阶段失败（exit=${r.code}），未产生任何改动`);
    }

    // agent 不应碰 origin/main。但并发跑时人（或另一个调度器）也可能在这期间合并了 main，
    // 所以不能只看「origin/main 变没变」——那会把别人的合法合并当成 agent 越界（#49 就这么被误杀过）。
    // 只有 main 的新 tip 长得像 agent 自己提交的（提交信息是我们的固定格式）才算越界。
    await git(['fetch', 'origin', 'main', '--quiet']);
    const mainAfter = (await git(['rev-parse', 'origin/main'])).out.trim();
    if (mainAfter !== mainBefore) {
      const tip = (await git(['log', '-1', '--format=%s', 'origin/main'])).out.trim();
      if (/^agent: (issue #\d+|fix CI for issue #\d+)/.test(tip)) {
        throw new Error(`agent 把提交推到了 origin/main（明确禁止），已中止：${tip}`);
      }
      log(`${tag} ℹ 任务期间 origin/main 前进（外部合并：${tip}），继续`);
    }

    const status = await worktreeStatus(wt);
    // 判「有没有干活」看的是文件变化，不是提交数：agent 为了绕开门禁会造空提交
    // （PR #40 就发生过），用 rev-list 计数会被它骗过去。
    const changedFiles = (await run(GIT, ['diff', '--name-only', 'origin/main...HEAD'], { cwd: wt })).out.trim();
    // 只读工单出现任何改动就是违约：不开 PR、不推送，改动清单进记忆库
    if (readonly && (status || changedFiles)) {
      const list = [changedFiles, status].filter(Boolean).join('\n').trim();
      recordFailure({ text: `[readonly] 只读工单产生了文件改动：\n${list}`, issue: n, attempt, reason: 'readonly-violation' }, FAIL_STORE);
      throw new Error(`[readonly] 只读工单（readonly:ok）却改动了文件，已中止且不开 PR：\n${list}\n只读工单只应回答结论，不应写文件。`);
    }
    if (!status && !changedFiles) {
      // 只读工单（查代码、做审计、回答问题）本来就不该产生改动。要求它改文件的门禁
      // 与「不要修改任何文件」的验收标准互斥，所以给一个显式出口：
      // issue 打 readonly:ok 时，把 agent 的结论贴成评论就算完成，不开 PR。
      if (readonly) {
        await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
        await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:ready')}`).catch(() => {});
        await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:done'] }).catch(() => {});
        await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
          body: `✅ 只读任务完成（未改动任何文件，按 readonly:ok 放行）\n\n${outTail.slice(-2000)}`,
        }).catch(() => {});
        log(`${tag} done（只读，无 PR）`);
        return;
      }
      const kind = headlessKind(r.out, r.err, r.code);
      throw new Error(`[headless] ${kind}｜agent 未产生任何改动（exit=${r.code}）\n输出尾部：\n${outTail.slice(-1500)}`);
    }

    // 1) 独立门禁：不接受作者自评
    const gate = await verifyWorktree(wt);
    // P6「日志落盘」：门禁的完整输出留一份（docs/88 #8）。以前只有失败的尾部进失败库，
    // 成功的门禁只剩一个 sha，事后无法回答「这次跑了哪些用例」。
    {
      const gl = writeGateLog(LOG_DIR, {
        issue: n, attempt,
        code: gate.ok ? 0 : (gate.env ? 'env' : 1),
        stdout: gate.stdout ?? gate.raw ?? gate.detail,
        sha: gate.gate_bytes_sha256,
      });
      if (!gl.ok) log(`${tag} ⚠ 门禁日志落盘失败（不影响判定）：${gl.why}`);
      else log(`${tag} 门禁输出落盘：${path.basename(gl.file)}`);
    }
    if (!gate.ok) {
      // v3 P2（docs/89 §3.5）：门禁失败时把第一个失败的测试钉出来。只看尾部 25 行
      // 经常看不到 TAP 的 not ok（它更靠前），所以用 verifyWorktree 带回来的完整输出。
      const firstError = gate.env ? { found: false } : parseFirstError(gate.raw ?? gate.detail);
      const firstErrorLine = firstError.found ? `\nFIRST_ERROR: ${formatFirstError(firstError)}` : '';
      if (firstError.found) log(`${tag} first_error：${formatFirstError(firstError)}`);
      // 环境失败不进失败指纹库：那不是「这单写错了」，记进去会污染「同类失败根因」，
      // 还会在下一轮被当成先验灌回 agent（让它去改根本没坏的测试）。
      if (!gate.env) recordFailure({ text: `${gate.detail}${firstErrorLine}`, issue: n, attempt, reason: gate.detail }, FAIL_STORE);
      const err = new Error(`${gate.detail}${firstErrorLine}`);
      if (gate.env) err.env = true;
      throw err;
    }

    // P4.5 变异探针（issue #235）：默认只扫描（0 次测试运行），只有 mutation:strict
    // 的工单才逐个变异体跑受影响测试。门禁已绿才探针，所以「存活」= 判据真的没人看着。
    {
      const mdiff = await run(GIT, ['diff', '--unified=0', 'origin/main...HEAD'], { cwd: wt });
      const msum = await probeWorktree({
        root: wt,
        patch: mdiff.out,
        strict: labels.includes('mutation:strict'),
        runTests: (mutant) => {
          const tf = testPathFor(mutant.file);
          const abs = tf === null ? '' : path.join(wt, tf);
          if (abs === '' || !existsSync(abs)) return Promise.resolve({ missingTest: true });
          return run(process.execPath, ['--test', tf], { cwd: wt, timeout: 300000 })
            .then((r) => ({ code: r.code, timedOut: r.timedOut }));
        },
      });
      const mdetail = msum.lines.length === 0 ? '' : '\n' + msum.lines.join('\n');
      if (msum.blocked) {
        recordFailure({ text: msum.text + mdetail, issue: n, attempt, reason: 'mutation-survivor' }, FAIL_STORE);
        throw new Error(msum.text + mdetail);
      }
      log(tag + ' ' + msum.text + mdetail);
    }

    // 可执行验收（issue 的 `### 验收命令`）：agent 自己写的测试只能自证，
    // 而这一段是提需求的人写的、agent 改不动，由调度器亲自跑一遍才算数。
    const acceptanceCmds = stripFence(acceptanceCmdsRaw);
    if (!acceptanceCmds) {
      // P0-6：没有验收命令的工单不进交付流程 —— 否则「做完了」全靠 agent 自述。
      // 例外：确实写不出可执行验收的工单，打 `acceptance:optional` 明确豁免。
      // v3 P1（docs/89 §3.4）：high-risk（含 unknown）不允许这个例外 —— 高风险单没有
      // 可执行验收等于没有裁判，必须补 `### 验收命令`。
      if (!labels.includes('acceptance:optional') || !lp.allowOptionalAcceptance) {
        const detail = (lp.forceStrictVerdict && labels.includes('acceptance:optional'))
          ? 'high-risk lane 不接受 `acceptance:optional` 豁免：请补 `### 验收命令`（高风险永远 T3）'
          : 'issue 缺少 `### 验收命令` 段：调度器没有可执行的验收，不生成 PR（确需豁免请打 `acceptance:optional` 标签）';
        recordFailure({ text: detail, issue: n, attempt, reason: 'missing acceptance command' }, FAIL_STORE);
        throw new Error(detail);
      }
      log(`${tag} 没有验收命令，但工单标了 acceptance:optional，继续`);
    }
    let acceptanceVerdict = 'none';
    // #237：证据一致性判据要读验收的实际 exit/输出（声明 PASS 但实际红 = 伪绿）。
    let acceptanceOut = '';
    let acceptanceCode = 0;
    if (acceptanceCmds) {
      const pol = commandPolicy(acceptanceCmds);
      if (!pol.ok) {
        recordFailure({ text: pol.reason, issue: n, attempt, reason: 'unsafe acceptance command' }, FAIL_STORE);
        throw new Error(pol.reason);
      }
      let res;
      if (process.env.DSH_S4_EXEC !== '0') {
        const r = await runAsAgentCommand({ cmd: acceptanceCmds, cwd: wt, timeoutSec: 300, actor: 'acceptance', issue: n });
        if (!r.done) {
          // 通道不可用属环境故障：与门禁同口径（env 标记，不烧重试预算、不进失败指纹库）。
          const e = new Error('ENV_FAIL: 低权验收通道不可用（' + (r.error || '没有 done.json') + '）；拒绝以 Administrator 执行验收命令');
          e.env = true;
          throw e;
        }
        if (r.code === 2 && !String(r.out || '').trim()) {
          // runner 自检失败（cwd 被拒/icacls 没生效）也会写 done.json exit=2，但不会有任何输出。
          const e = new Error('ENV_FAIL: 低权验收通道内部错误（exit 2，无输出）');
          e.env = true;
          throw e;
        }
        res = { code: r.code, out: r.out, err: '' };
      } else {
        log('[s4-warn] DSH_S4_EXEC=0：验收命令改由 Administrator 执行（降权被关闭，仅限调试；不可用于对外仓）');
        res = await run(BASH, ['-lc', acceptanceCmds], {
          cwd: wt, timeout: 300_000, env: { PATH: CHILD_PATH, PNPM_CLI },
        });
      }
      // 退出码 0 只说明「命令没崩」，不说明「验收过了」：有 VERDICT 行就以它为准。
      // high-risk lane 强制 strict：没有 VERDICT 行即失败（docs/89 §3.4 → 永远 T3）。
      const decision = decideAcceptance(res, { strict: labels.includes('verdict:strict') || lp.forceStrictVerdict });
      acceptanceVerdict = decision.verdict;
      acceptanceOut = `${res.out ?? ''}\n${res.err ?? ''}`;
      acceptanceCode = Number(res.code ?? 0);
      const output = `${res.out ?? ''}\n${res.err ?? ''}`.trim();
      if (!decision.ok) {
        const detail = `验收未通过（${decision.detail}）：\n${acceptanceCmds}\n\n${output.slice(-2000)}`;
        recordFailure({ text: detail, issue: n, attempt, reason: 'acceptance command failed' }, FAIL_STORE);
        throw new Error(detail);
      }
      if (decision.verdict === 'unknown') log(`${tag} ⚠ ${decision.detail}`);
      log(`${tag} 验收命令通过（${acceptanceCmds.split('\n').length} 行，裁决=${decision.verdict}）`);
    }

    // docs/89 §3.6：high-risk（含 unknown）工单额外走仓外 tools/pipeline/run.mjs 薄适配器。
    // 契约由 issue 的 `### 高风险验证` 给出 spec 目录；适配器只传参、解析 0/2/3/4/5/6、回写证据，
    // 不自己造 spec 格式。默认 auto：有段才跑；required：缺段即 fail-closed。
    if (lp.lane === 'high-risk') {
      // 注：下面三处（门禁/验收/高风险）都以 Administrator 之外的身份或固定命令执行，
      // 见 docs/security-remediation-20261109.md 与 ci/s4-exec.mjs。
      const specRaw = stripFence(pick(sections, '高风险验证')).split('\n')[0].trim();
      // 规范化后再判范围：适配器以 Administrator 执行 issue 指定的目录，相对路径必须先落到仓根，
      // 否则 `..\..\.worktrees\x`（agent 可写）能被当成"仓内相对路径"混过去。
      const specAbs = specRaw ? path.resolve(path.isAbsolute(specRaw) ? specRaw : path.join(REPO_DIR, specRaw)) : '';
      const insideRepo = Boolean(specAbs) && specAbs.toLowerCase().startsWith(REPO_DIR.toLowerCase() + '\\');
      const allowSpecs = Boolean(specAbs) && specAbs.toLowerCase().startsWith('d:\\code\\.pipeline-specs');
      const specDir = specAbs && (insideRepo || allowSpecs) ? specAbs : '';
      if (specAbs && !(insideRepo || allowSpecs)) {
        // fail-closed：适配器以 Administrator 跑，目录由 issue 正文给出 → 仓外/UNC/驱动器的路径一律拒绝执行，
        // 不能"忽略后当没给"（那会让 high-risk 工单静默降级成普通门禁）。
        const detail = '高风险验证目录规范化后不在允许范围（仓内或 d:\\code\\.pipeline-specs）：' + specRaw + ' → ' + specAbs;
        recordFailure({ text: detail, issue: n, attempt, reason: 'unsafe high-risk spec dir' }, FAIL_STORE);
        throw new Error(detail);
      }
      const mode = process.env.DSH_HIGH_RISK_ADAPTER || 'auto';
      if (specDir) {
        const runJs = findRunJs(REPO_DIR);
        // verify 只能是固定命令：run.mjs 用 shell:true 执行它，而原来这里回放的是 issue 正文里的
        // `### 验收命令` → 等于把外部文本交给 Administrator shell。验收段已在上一步单独以低权跑过，
        // 适配器这里只需要一个可信的复跑命令。
        const hr = await runHighRiskAdapter({
          runJs, specDir, repoDir: REPO_DIR, verify: 'bash scripts/verify.sh',
        });
        recordLane(LANE_STATS_FILE, { issue: n, kind: 'high-risk-adapter', ok: hr.ok, code: hr.code, why: hr.reason });
        if (!hr.ok) {
          const detail = `high-risk 适配器拒绝（exit ${hr.code}，${hr.reason}）：\n${String(hr.out ?? '').slice(-2000)}`;
          recordFailure({ text: detail, issue: n, attempt, reason: 'high-risk adapter failed' }, FAIL_STORE);
          throw new Error(detail);
        }
        log(`${tag} high-risk 适配器通过（exit 0）：${specDir}`);
      } else if (mode === 'required') {
        throw new Error('high-risk 工单缺 `### 高风险验证`（spec 目录）：DSH_HIGH_RISK_ADAPTER=required 下 fail-closed');
      } else {
        log(`${tag} ⚠ high-risk 工单未给 \`### 高风险验证\`，跳过仓外适配器（DSH_HIGH_RISK_ADAPTER=required 可强制）`);
      }
    }

    if (status) {
      // agent 有时会用 git add -f 把调度器自己写的 .dsh/PLAN.md 一起提交（实测 #64），
      // 那是内部笔记：从索引里摘掉，别让它进 PR，也别让评审团把它算成越界改动。
      await run(GIT, ['rm', '-r', '--cached', '--quiet', '.dsh'], { cwd: wt });
      await run(GIT, ['add', '-A'], { cwd: wt });
      const c = await run(GIT, ['-c', 'user.name=dsh-agent', '-c', 'user.email=agent@dsh.local', ...SAFE_HOOKS,
        'commit', '-m', `agent: issue #${n}`], { cwd: wt });
      if (c.code !== 0) throw new Error(`commit 失败: ${c.err.trim()}`);
    }

    // #236 P5.5：提交后核对主仓漂移。只读工单没有提交，也就不涉及这一层。
    if (status) {
      const driftAfter = await takeSnapshot({ repoDir: REPO_DIR, run, git: GIT });
      const drift = compareSnapshots(driftBefore, driftAfter);
      // 快照落 .logs/（issue #236 建议第 3 条）：事后能翻出任务前后主仓到底长什么样。
      try {
        if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
        writeFileSync(path.join(LOG_DIR, `repo-drift-issue-${n}-attempt-${attempt}.json`),
          JSON.stringify({ issue: n, attempt, at: new Date().toISOString(), before: driftBefore, after: driftAfter, blocked: drift.blocked, excludeChanged: drift.excludeChanged, added: drift.added }, null, 2));
      } catch { /* 日志写不了不影响判定 */ }
      if (drift.blocked) {
        const detail = '主仓漂移（P5.5，任务期间出现）：\n' + formatRepoDrift(drift);
        recordFailure({ text: detail, issue: n, attempt, reason: 'repo drift' }, FAIL_STORE);
        throw new Error(detail);
      }
      log(`${tag} 主仓无漂移（exclude 未改，未放行条目 0）`);
    }

    // v3 P1（docs/89 §3.1/§3.2）：门禁通过 + 本次提交签发一条 witness。
    // 签发点放在「提交之后」：§3.1 要求工作树干净才签，而 overlay 快照门禁是在 agent 的脏
    // 工作树上跑的；提交后 HEAD/tree 才是合并判据（L2：合并树哈希 == witness.tree_after）
    // 能引用的那个。工作树不干净时 attestCommit 直接拒绝（fail-closed）。
    const att = attestCommit({
      repoDir: wt, issue: n, stdout: gate.stdout, gateBytes: gate.gate_bytes_sha256, chainFile: WITNESS_FILE,
      privateKeyPath: WITNESS_SIGNING ? WITNESS_KEY : null, keyId: WITNESS_KEY_ID,
    });
    if (!att.ok) throw new Error(`证据签发失败（不 push 未签名证据）：${att.why}`);
    log(`${tag} witness ${att.witness.hash.slice(0, 12)}：commit ${att.witness.commit.slice(0, 8)} tree ${att.witness.tree_after.slice(0, 8)}`);

    // 2) 评审层：机械判定，push 之前拦
    const review = reviewAfterCommit(wt, 'origin/main', { allowGate });
    if (!review.ok) {
      recordFailure({ text: review.detail, issue: n, attempt, reason: review.detail }, FAIL_STORE);
      throw new Error(review.detail);
    }
    // #236 verify-clean：动过门禁/基线的提交要证明「提交后的 HEAD 自己」也能跑出 PASS。
    // 门禁字节在候选树里来自 origin/main（overlay），提交后的树才是 HEAD——两者不一致时
    // 云端 CI 才会红，调度器在这里提前复算。没动门禁的提交门禁字节完全一致，不重复跑。
    if (status) {
      const changed = ((await run(GIT, ['diff', '--name-only', 'origin/main...HEAD'], { cwd: wt })).out || '')
        .split(/\r?\n/).filter(Boolean);
      const touchedBaseline = changed.some((f) => BASELINE_FILES.includes(f));
      // 只有「仅动了基线数字（bless）」的提交才在这里复算：scripts/verify.sh 与 ci/ 的字节
      // 仍来自 origin/main，跑的是可信代码。实体门禁文件的改动（allow:gate）不在这里以
      // Administrator 身份执行 agent 的脚本——那会绕过 S4 降权隔离，交给人工评审 + 云端 CI。
      const touchedOpaqueGate = changed.some((f) => (f.startsWith('ci/') || f.startsWith('scripts/')) && !BASELINE_FILES.includes(f));
      if (touchedOpaqueGate && touchedBaseline) {
        log(`${tag} ⚠ 提交同时改了门禁实体文件与基线：跳过本地 verify-clean（由 allow:gate 人工评审 + 云端 CI 兜底）`);
      } else if (touchedBaseline) {
        log(`${tag} 提交含 bless 基线，复算 verify-clean（不带 --bless）`);
        const vc = await run(BASH, ['scripts/verify.sh'], {
          cwd: wt, timeout: 15 * 60 * 1000, env: { PATH: CHILD_PATH, PNPM_CLI },
        });
        const vcOut = `${vc.out ?? ''}\n${vc.err ?? ''}`;
        const v = verifyCleanVerdict({ code: vc.code, out: vcOut });
        if (!v.ok) {
          recordFailure({ text: `${v.why}\n\n${vcOut.slice(-2000)}`, issue: n, attempt, reason: 'head not recomputable' }, FAIL_STORE);
          throw new Error(v.why);
        }
        log(`${tag} verify-clean 通过（HEAD 可复算）`);
      }
    }

    // #237 P7.5：质疑者三判据（机械、不跑模型）。语义评审判「是否满足验收」，
    // 这里复算可数事实：断言数 ↔ 基线、新符号是否有测试引用、证据与退出码是否一致。
    // 只在 high-risk lane 硬闸（fail），普通工单记 warn——机械判据有近似误差，不值得为此丢单。
    if (status) {
      const falDiff = (await run(GIT, ['diff', '--unified=0', 'origin/main...HEAD'], { cwd: wt })).out || '';
      const baseBl = parseBaseline((await run(GIT, ['show', 'origin/main:scripts/test-baseline.txt'], { cwd: wt })).out || '');
      let headBl = null;
      try { headBl = parseBaseline(readFileSync(path.join(wt, 'scripts/test-baseline.txt'), 'utf8')); } catch { /* 基线文件可缺 */ }
      const delta = countAssertions(falDiff);
      const testFiles = ((await run(GIT, ['ls-files'], { cwd: wt })).out || '').split(/\r?\n/).filter((f) => TEST_FILE_RE.test(f));
      let testSource = '';
      for (const f of testFiles) { try { testSource += readFileSync(path.join(wt, f), 'utf8'); } catch { /* 读不到按无引用处理 */ } }
      const falChecks = [
        checkAssertDelta({ base: baseBl, head: headBl, ...delta }),
        checkSymbolBinding({ exports: findNewExports(falDiff), testSource }),
        checkEvidence({ declared: acceptanceVerdict === 'pass' ? 'pass' : acceptanceVerdict === 'unknown' ? 'unknown' : 'none', code: acceptanceCode, out: acceptanceOut }),
      ];
      const falVerdict = summarizeFalsifier(falChecks);
      try {
        writeFileSync(path.join(LOG_DIR, `falsifier-issue-${n}-attempt-${attempt}.json`),
          JSON.stringify({ issue: n, attempt, at: new Date().toISOString(), verdict: falVerdict, checks: falChecks }, null, 2));
      } catch { /* 报告写不了不影响判定 */ }
      const failed = falChecks.filter((c) => c.result !== 'pass');
      if (failed.length) {
        const detail = `falsifier（P7.5）${falVerdict}：\n` + failed.map((c) => `- [${c.rule}] ${c.result}：${c.detail}`).join('\n');
        if (lp.lane === 'high-risk') {
          recordFailure({ text: detail, issue: n, attempt, reason: 'falsifier failed' }, FAIL_STORE);
          throw new Error(detail);
        }
        log(`${tag} ⚠ ${detail}`);
      } else {
        log(`${tag} falsifier（P7.5）通过：${falChecks.map((c) => c.rule).join('、')}`);
      }
    }

    const warns = (review.findings ?? []).filter((f) => f.severity === 'warn');
    // 自动化路径的放行也要留痕：issue 上的 allow:gate 有机械校验，但同样得能被事后翻出来。
    if (allowGate) {
      const gateFiles = gateFilesFromFindings(review.findings ?? []);
      if (gateFiles.length) {
        log(`${tag} ⚠ 按 issue 的 allow:gate 放行门禁改动：${gateFiles.join('、')}`);
        notifyEvent({ kind: 'gate-override', issue: n, why: `allow:gate 放行：${gateFiles.join('、')}` });
      }
    }

    // 3) 语义评审：机械规则只看 diff 的形状（删测试、漏 bless、动 workflows），
    // 看不出「代码写得像那么回事，但根本没满足验收标准」。这里请另一个家族的模型
    // 读验收标准 + 实际 diff；block 就把它的意见当成失败原因回灌给下一次重试。
    const diff = collectDiff(wt);
    const semT0 = Date.now();
    const semantic = diff.ok
      ? await reviewWithPanel({
        issueNumber: n, title: issue.title, goal, acceptance, constraints, diffText: diff.text, files: diff.files,
        acceptanceNote: acceptanceCmds ? `调度器已在本 worktree 里执行过验收命令，全部 exit 0：\n\`\`\`\n${acceptanceCmds}\n\`\`\`` : '',
      })
      : {
        ok: false,
        verdict: 'block',
        findings: [{ severity: 'block', rule: 'semantic-diff-failed', file: null, message: `拿不到 diff：${diff.error}` }],
        model: '-',
      };
    const semMs = Date.now() - semT0;
    log(`${tag} 语义评审：${formatSemantic(semantic).split('\n')[0]}（${Math.round(semMs / 1000)}s，${(diff.files ?? []).length} 个文件）`);
    if (semantic.paidUsed) {
      // 用户 2026-10-27：留痕本身也要花钱，所以默认只进 dispatch.log 与 PR body 一行；
      // 只有这次付费评审的估算成本超过阈值（默认 ¥0.05）才额外写 issue 评论。
      log(`${tag} ⚠ 语义评审切到付费面板（免费模型 ${semantic.freeModel} 不可用：${semantic.escalatedFrom}）`);
      const notifyCny = Number(process.env.DSH_NOTIFY_CNY ?? process.env.DSH_PAID_NOTIFY_CNY ?? 0.05);
      const semCny = (semantic.tokens ?? 0) * (4 / 1e6); // 保守按输出价 4 元/百万估算
      if (semCny < notifyCny) {
        log(`${tag} 付费评审估算 ${formatCny(semCny)} < 阈值 ${formatCny(notifyCny)}，只记日志不写 issue 评论`);
      } else try {
        await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
          body: [
            '⚠️ 这次语义评审用了**付费模型**。',
            '',
            `- 免费档模型：\`${semantic.freeModel}\``,
            `- 免费档不可用原因：${semantic.escalatedFrom}`,
            `- 实际使用的付费模型：${(semantic.reviewers ?? []).filter((r) => r.verdict !== 'skipped').map((r) => `\`${r.model}\``).join('、') || '（全部不可用）'}`,
            '',
            '这个原因反复出现就说明免费额度或凭证需要处理。',
          ].join(String.fromCharCode(10)),
        });
      } catch (e) {
        log(`${tag} ⚠ 付费切换的 issue 评论没发出去：${e.message}`);
      }
    }
    // 评审层整层缺失（全跳过）不等于 pass：默认 fail-closed，只有显式 DSH_REVIEW_MISSING=allow
    // 才放行，且两种情况都必须发事件——凭证失效时这一层会静默消失，只有日志一行没人会发现。
    if (semantic.verdict === 'missing') {
      log(`${tag} ⚠ 语义评审缺失（这一层等于没有）：${semantic.skipped}`);
      notifyEvent({ kind: 'review-missing', issue: n, why: `语义评审没有可用的模型：${semantic.skipped}` });
      const allowMissing = (process.env.DSH_REVIEW_MISSING ?? '') === 'allow';
      if (!allowMissing) {
        const detail = `语义评审缺失（改动未推送）：\n${formatSemantic(semantic)}\n确需放行：设 DSH_REVIEW_MISSING=allow（会写进 events.jsonl）。`;
        recordFailure({ text: detail, issue: n, attempt, reason: detail.slice(0, 1500) }, FAIL_STORE);
        throw new Error(detail);
      }
      log(`${tag} ⚠ 已按 DSH_REVIEW_MISSING=allow 放行（本次没有语义评审，PR 里会标注）`);
      semantic.ok = true;
    }
    if (!semantic.ok) {
      const detail = `语义评审拒绝（改动未推送）：\n${formatSemantic(semantic)}`;
      recordFailure({ text: detail, issue: n, attempt, reason: detail.slice(0, 1500) }, FAIL_STORE);
      throw new Error(detail);
    }

    // 台账只追加、失败不影响任务：它回答的是「这单怎么判的」，不是交付物本身。
    try {
      appendLedger(defaultLedgerFile(), ledgerEntry({
        issue: n, attempt,
        acceptance: acceptanceCmds ? 'yes' : 'none',
        acceptanceVerdict,
        semantic: semantic.verdict,
        files: (diff.files ?? []).length,
        cny: taskCny,
      }));
    } catch (e) {
      log(`${tag} ⚠ 台账写入失败（不影响任务）：${e.message}`);
    }

    await pushWithRetry(wt, `${branch}:${branch}`);

    const pr = await api('POST', `/repos/${REPO}/pulls`, {
      title: `[agent] #${n} ${issue.title}`.slice(0, 250),
      head: branch,
      base: 'main',
      body: [
        `由调度器自动生成，对应 #${n}。`,
        '', '## 目标', goal, '', '## 验收标准', acceptance,
        '',
        '## 自动检查',
        `- 独立门禁 \`bash scripts/verify.sh\`：通过（调度器自己跑的，不采信 agent 自述）`,
        `- 评审层：通过${warns.length ? `，${warns.length} 条提示` : '，无问题'}`,
        ...warns.map((w) => `  - ⚠ [${w.rule}] ${w.message}${w.file ? `（${w.file}）` : ''}`),
        `- 语义评审：${formatSemantic(semantic).split(String.fromCharCode(10))[0]}${semantic.paidUsed ? `（⚠ 免费模型 ${semantic.freeModel} 不可用，已切付费）` : ''}`,
        ...(semantic.needsHuman
          ? ['- ⚠ 评审团没凑够家数：**不允许自动合并**，必须人工复核']
          : semantic.verdict === 'missing' ? ['- ⚠ 本次没有语义评审（按 `DSH_REVIEW_MISSING=allow` 放行）：**不允许自动合并**'] : []),
        `- 验收命令：${acceptanceCmds ? `已通过（${acceptanceCmds.split('\n').length} 行，调度器执行，裁决=${acceptanceVerdict}）` : 'issue 里没有给 `### 验收命令`（按 acceptance:optional 豁免）'}`,
        `- 本次 agent 消耗：${formatUsage(usage)}${taskCny !== null ? `（估算 ${formatCny(taskCny)}）` : ''}`,
        ...(semantic.findings ?? []).map((f) => `  - ${f.severity === 'block' ? '✗' : '⚠'} [${f.rule}] ${f.message}${f.file ? `（${f.file}）` : ''}`),
        '',
        '## 需要人工确认（调度器不做）',
        '- 这份改动是否符合你真正想要的东西 —— 机器只能验「写了的东西对不对」，不能验「该不该写」。',
        '- 合并动作本身：本流水线不会自动 merge，也不会自动打 tag / 发版。',
        '- 若验收命令没有打印 `VERDICT: PASS`，说明这次只是「命令没崩」，人工要自己看一眼输出。',
        '', '---', 'CI 通过后请人工 review 再合并。',
        // 机器读的标记：评审降级/缺失时禁止 merge:auto 自动合并（不依赖人记得看正文）。
        ...(semantic.needsHuman || semantic.verdict === 'missing' ? ['', '<!-- semantic:needs-human -->'] : []),
      ].join('\n'),
    });
    let prUrl = pr.status === 201 ? pr.data.html_url : null;
    if (!prUrl) {
      const list = await api('GET', `/repos/${REPO}/pulls?head=${branch}&state=open`);
      prUrl = Array.isArray(list.data) ? list.data[0]?.html_url : null;
    }

    // 摘掉 ready/working，否则 label 状态会显示成「该 issue 还在排队」；
    // 虽然轮询过滤了 agent:done，但脏 label 会误导人，也挡不住手工重打 ready 时的重复执行。
    await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
    await api('DELETE', `/repos/${REPO}/issues/${n}/labels/${encodeURIComponent('agent:ready')}`).catch(() => {});
    await api('POST', `/repos/${REPO}/issues/${n}/labels`, { labels: ['agent:done'] }).catch(() => {});
    await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
      body: `✅ 已生成 PR：${prUrl ?? '（PR 已存在但查询失败）'}\n\n耗时 ${secs}s。`,
    }).catch(() => {});
    log(`${tag} done → ${prUrl}`);
    // 这张单跑成了：清掉与它绑定的重试计数，避免「上一轮攒满 2 次环境失败、人工解挂后
    // 再遇一次偶发失败就立刻挂起」——计数要跟着这一轮，而不是跟着工单号永久累积。
    ENV_RETRIES.delete(n);
    RATE_LIMIT_RETRIES.delete(n);
    ZERO_TOKEN_FAILS.delete(n);
  } catch (e) {
    const reason = String(e?.stack || e);
    // 环境失败走结构化标记优先，文本匹配只作兜底：门禁 exit 78 时 verifyWorktree 会把
    // Err.err = true 挂在错误对象上，比在堆栈里找子串可靠（测试输出里也可能出现同名字面量）。
    const envFailure = e?.env === true || /(^|\n)ENV_FAIL:|\bspawn EPERM\b/.test(reason);
    // 记下这一轮是不是环境噪声：下一轮据此决定要不要接着同一个会话跑。
    const kindHit = /\[headless\]\s*([a-z0-9-]+)/.exec(reason);
    if (kindHit && prevSession && prevSession.id) ISSUE_SESSION.set(n, { id: prevSession.id, kind: kindHit[1] });

    // 环境失败（沙箱不允许 spawn / 门禁自己判 exit 78）不是「这单写错了」：
    // 按红线单独计数、不推高 attempt；重试用尽就挂起交给人，这样一张好工单不会因为
    // 机器限制被三次重试判死。这一段必须排在免费池判定之前——环境失败的文本可能
    // 撞上池子的关键词，被误送去「挂起等池子恢复」就再也回不来了。
    if (envFailure) {
      const tries = ENV_RETRIES.get(n) ?? 0;
      if (tries < ENV_RETRY_MAX) {
        ENV_RETRIES.set(n, tries + 1);
        const waited = envRetryWaitMs();
        log(`${tag} 环境失败（不是写错），等 ${Math.round(waited / 1000)}s 后重试（第 ${tries + 1}/${ENV_RETRY_MAX} 次，不占重试预算）`);
        await new Promise((r) => setTimeout(r, waited));
        return runTask(issue, attempt, reason);
      }
      log(`${tag} 环境失败重试 ${ENV_RETRY_MAX} 次仍失败：挂起交给人，不判为写错`);
      await blockManual(issue, `环境失败（重试 ${ENV_RETRY_MAX} 次仍不可用）`, `门禁无法在受限环境里启动子进程。\n\n${reason.slice(-1200)}`);
      return;
    }
  // agent 的原始输出里常带真实的 429 文本（reason 只有 agent-exit-1），所以先取尾部再判。
  const rawTail = String(LAST_RAW.get(n) || '').slice(-800).replace(/\s+/g, ' ').trim();
  // 限流（429 / TPM limit reached / upstream 429）是环境噪声，不是这次改动的问题：等一会儿再来，
  // 而且**不消耗重试预算**——2026-10-26 实测三次 429 就把 #69 判了死，白丢一次任务。
  // 必须排在免费池判定之前：429 的文本也可能撞上池子的关键词，被判成「额度耗尽→挂起」后
  // 就再也不会重试（2026-11-08 实测 Flash-Next 连续 429 被直接 block）。
  // 限流重试用尽：按普通失败处理，但**不能**让下面的免费池判定把它标成「额度耗尽→挂起」，
  // 那会把「等 8 分钟就恢复的限流」误报成账户问题（2026-11-08 #121 实测）。
  let rateLimitExhausted = false;
  if (/llm-rate-limit|RATE_LIMIT: 429|TPM limit reached|upstream 429/i.test(`${reason}\n${rawTail}`)) {
    const tries = RATE_LIMIT_RETRIES.get(n) ?? 0;
    if (tries < RATE_LIMIT_MAX) {
      RATE_LIMIT_RETRIES.set(n, tries + 1);
      const waited = rateLimitWaitMs();
      log(`${tag} 撞到限流，等 ${Math.round(waited / 1000)}s 后重试（第 ${tries + 1}/${RATE_LIMIT_MAX} 次，不计重试次数）`);
      await new Promise((r) => setTimeout(r, waited));
      return runTask(issue, attempt, reason);
    }
    log(`${tag} 限流重试 ${RATE_LIMIT_MAX} 次仍失败，按普通失败处理`);
    rateLimitExhausted = true;
  }
  // 免费档额度用尽（modelscope 返回 insufficient balance）不是「这单写错了」，
  // 而是免费池这个模型暂时不可用：本单改走付费档重来一次，不消耗重试预算。
  // 免费档不可用时改走付费：两条判据——
  // ① 文本命中额度/余额/无可用模型（含本轮原始输出的尾部，防止报错被截断后漏判）；
  // ② 连续 2 次 0 token（模型根本没开始干活），不看文本也能判定。
  const zeroTries = ZERO_TOKEN_FAILS.get(n) ?? 0;
  const quotaish = /QUOTA|insufficient[ _-]?balance|余额不足|无可用模型|no available model/i.test(`${reason}\n${rawTail}`);
  // 免费池不可用（额度耗尽 / 连续 0 token）时的处置交给 pool-block.mjs 的纯函数，
  // 默认挂起工单而不是自动烧付费（DSH_FREE_POOL_BLOCK=0 可退回旧行为）。
  const poolText = `${reason}${NL}${rawTail}`;
  const poolWhy = blockReason({ text: poolText, zeroTries });
  const poolDecision = freePoolDecision({ text: poolText, zeroTries, usePaid, enabled: FREE_POOL_BLOCK });
  if (!rateLimitExhausted && poolDecision === 'block') {
    await blockTask(issue, poolWhy, rawTail);
    return;
  }
  if (!rateLimitExhausted && poolDecision === 'paid') {
    FORCE_PAID.add(n);
    log(`${tag} 免费档不可用（${poolWhy}），本单改用 deepseek-flash（付费）后重试${rawTail ? '：' + rawTail.slice(-200) : ''}`);
    return runTask(issue, attempt, reason);
  }
  if (rawTail) log(`${tag} 失败时的原始输出尾部：${rawTail.slice(-400)}`);
    // 失败指纹入仓：下次同类失败（哪怕换一张工单）能直接拿到这次的根因。
    try { recordFailure({ text: reason, issue: n, attempt, reason: reason.slice(0, 1500) }, FAIL_STORE); } catch { /* 记账失败不影响重试 */ }
    if (attempt < MAX_ATTEMPTS) {
      log(`${tag} 第 ${attempt}/${MAX_ATTEMPTS} 次失败，自动重试：${reason.split('\n')[0].slice(0, 180)}`);
      await api('POST', `/repos/${REPO}/issues/${n}/comments`, {
        body: `⚠️ 第 ${attempt} 次执行失败，正在自动重试（上限 ${MAX_ATTEMPTS} 次）。\n\n\`\`\`\n${reason.slice(0, 1200)}\n\`\`\``,
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2000));
      return runTask(issue, attempt + 1, reason);
    }
    await failTask(issue, `${MAX_ATTEMPTS} 次尝试均失败。\n\n最后一次错误：\n${reason}`);
  } finally {
    await locked(() => git(['worktree', 'remove', '--force', wt])).catch(() => {});
  }
}

// ---------- 轮询 ----------

// github.com 的 git 通道会间歇性重置连接（实测 push 报 `Recv failure: Connection was reset`，
// 几秒后重试就成功），所以 push 也要退避重试，不能一次失败就把整轮 rebase 判死。
async function pushWithRetry(cwd, refspec, extraArgs = []) {
  // v3 P1（docs/89 §3.1）：push 前断言。链必须完整，且要推的 HEAD 被某条 witness 覆盖
  // （commit + tree_after 双匹配，§3.2 L2）。放在退避重试之前判一次：网络失败可以重试，
  // 证据缺失重试也补不出来；这条不通过就绝不 push。
  const proof = assertHeadWitnessed({ repoDir: cwd, chainFile: WITNESS_FILE, keyring: WITNESS_KEYS });
  if (!proof.ok) throw new Error(`push 前断言失败（拒推未签名证据）：${proof.why}`);
  const backoff = [3000, 7000, 15000, 30000];
  let last = null;
  for (let i = 0; i <= backoff.length; i += 1) {
    last = await run(GIT, ['-c', 'credential.helper=', 'push', ...extraArgs, 'origin', refspec], { cwd, env: gitEnv() });
    if (last.code === 0) return;
    if (i < backoff.length) await new Promise((r) => setTimeout(r, backoff[i]));
  }
  if (networkError(last)) {
    log('[net] https 推不上去，改走 SSH 端点');
    const viaSsh = await run(GIT, ['-c', 'credential.helper=', 'push', ...extraArgs, SSH_REMOTE, refspec],
      { cwd, env: sshEnv() });
    if (viaSsh.code === 0) return;
    last = viaSsh;
  }
  throw new Error(`push 失败（退避重试 ${backoff.length + 1} 次 + SSH 端点）: ${last.err.trim().slice(0, 200)}`);
}

// 本批次是否因为超预算而暂停领取新任务（软熔断：已完成的活不丢，只是不再开新的）。
// 持久化：启动时从 .logs/state.json 读回来。以前它只是内存变量，日闸熔断后计划任务把进程
// 重拉一次就满血复活，等于日闸在重启面前不设防（2026-11-06 终稿裁决）。
let PAUSE_CLAIM = readState(LOG_DIR).paused;
// 日闸通知的「最后一次通知是哪一天」（北京时间日期）。进程重启会重置，重启后再提示一次也合理。
let DAYCAP_NOTIFIED = '';

// 统一的暂停入口：内存 + 落盘一起改，避免出现「日志说暂停了、重启又开跑」。
// PAUSE_DISK_OK = 当前内存暂停态是不是磁盘写下的（落盘失败时为假，此时对账不能把它抹掉）。
let PAUSE_DISK_OK = false;
function pauseClaim(why) {
  if (PAUSE_CLAIM) return;
  PAUSE_CLAIM = true;
  try { setPaused(LOG_DIR, why); PAUSE_DISK_OK = true; } catch (e) { log(`[state] 暂停态落盘失败（仍按内存暂停）：${e.message}`); }
}

// 常驻进程的暂停态必须跟着磁盘走：`--pause`/`--resume` 由人（或另一个进程）下单，
// 只在启动时读一次等于「运行中不生效」。只在状态翻转时打日志，避免每 30 秒刷屏。
function syncPauseFromDisk() {
  let st;
  try { st = readState(LOG_DIR); } catch { return; } // 读不出来就维持内存判断，不擅自改成「可领单」
  const r = reconcilePause(PAUSE_CLAIM, PAUSE_DISK_OK, st);
  PAUSE_DISK_OK = r.diskBacked;
  if (r.transition === 'paused') {
    PAUSE_CLAIM = true;
    const why = st.corrupt ? `状态文件损坏（按暂停处理）：${st.pausedWhy || ''}` : (st.pausedWhy || '未写原因');
    log(`⏸ 检测到暂停：${why}——本轮起不再领新单（--resume 可解除）`);
    if (st.corrupt) notifyEvent({ kind: 'state-drift', why: `state.json 损坏，按暂停处理：${st.pausedWhy || ''}` });
  } else if (r.transition === 'resumed') {
    PAUSE_CLAIM = false;
    log('▶ 检测到暂停已解除，恢复领单');
  }
}

function todaySpendCny() {
  try {
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const f = path.join(LOG_DIR, 'usage.jsonl');
    if (!existsSync(f)) return 0;
    const rows = [];
    for (const line of readFileSync(f, 'utf8').split(NL)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t);
        const d = new Date(Date.parse(e.at) + 8 * 3600 * 1000).toISOString().slice(0, 10);
        if (d === today) rows.push(e);
      } catch { /* 坏行跳过 */ }
    }
    // 已计量按 cny 求和，未计量按次估价：宁可高估（日闸是熔断器，低估等于没有）。
    const spend = spendOfRows(rows);
    if (spend.unmetered > 0) {
      log(`[cost] 今日 ${rows.length} 次跑动里 ${spend.unmetered} 次没有 token 统计，按 ${formatCny(spend.unitCny)}/次保守计入`);
    }
    return spend.cny;
  } catch { return 0; }
}

// 依赖门：issue 上带 dep-on:T1 → 只有 T1 对应的 issue 关闭后才允许开工。
// 标签里的 T1 是 tasks.md 的任务号，靠标题里的 [slug/T1] 反查 issue 号。
async function depsSatisfied(issue) {
  const deps = (issue.labels ?? []).map((l) => l.name).filter((n) => n.startsWith('dep-on:')).map((n) => n.slice('dep-on:'.length));
  if (!deps.length) return { ok: true };
  const slug = /^\[([^/\]]+)\//.exec(issue.title || '')?.[1] || '';
  for (const d of deps) {
    const q = encodeURIComponent(`[${slug}/${d}]`);
    const { data } = await api('GET', `/repos/${REPO}/issues?state=closed&per_page=100&labels=agent:done`);
    const list = Array.isArray(data) ? data : [];
    const closedDep = list.some((i) => !i.pull_request && String(i.title || '').includes(`[${slug}/${d}]`));
    if (!closedDep) return { ok: false, dep: d };
  }
  return { ok: true };
}

// 作者/贴标人双闸的支持数据（2026-11-09）。协作者表 10 分钟缓存；读不到就退化成「只信任
// 所有者 + DSH_TRUSTED_AUTHORS」，绝不因为 API 抖动而放行陌生人（fail-closed）。
const TRUSTED_LOGIN_TTL_MS = 10 * 60 * 1000;
let trustedLoginCache = { at: 0, set: null };

async function trustedLogins() {
  if (trustedLoginCache.set && Date.now() - trustedLoginCache.at < TRUSTED_LOGIN_TTL_MS) return trustedLoginCache.set;
  const owner = String(REPO).split('/')[0];
  try {
    const rows = [];
    for (let page = 1; page <= 5; page += 1) {
      const { data } = await api('GET', `/repos/${REPO}/collaborators?per_page=100&page=${page}`);
      const list = Array.isArray(data) ? data : [];
      rows.push(...list);
      if (list.length < 100) break;
    }
    trustedLoginCache = { at: Date.now(), set: collaboratorLogins(rows, owner) };
  } catch (e) {
    log(`[author-gate] 读不到仓库协作者表（${e.message}）：本轮只信任所有者与 DSH_TRUSTED_AUTHORS`);
    trustedLoginCache = { at: Date.now(), set: collaboratorLogins([], owner) };
  }
  return trustedLoginCache.set;
}

// 取 issue 的 agent:ready labeled 事件（升序，最多 5 页 = 500 条）：最新一条的 actor 即贴标人。
// 创建时就带 label 的 issue 不产生 labeled 事件 —— 那种单会在这里被拒，必须建单后再贴一次。
async function fetchAgentReadyEvents(n) {
  const hits = [];
  for (let page = 1; page <= 5; page += 1) {
    const { data } = await api('GET', `/repos/${REPO}/issues/${n}/events?per_page=100&page=${page}`);
    const list = Array.isArray(data) ? data : [];
    for (const e of list) {
      if (e?.event === 'labeled' && String(e?.label?.name ?? '').toLowerCase() === 'agent:ready') hits.push(e);
    }
    if (list.length < 100) return { events: hits, truncated: false };
  }
  return { events: hits, truncated: true };
}

async function pollOnce() {
  // 每轮都读一次状态文件：`--pause`/`--resume` 是人从另一个进程下单的，
  // 只在启动时读一次（旧做法）意味着运行中的常驻进程根本不理它，钱闸形同虚设。
  syncPauseFromDisk();
  if (PAUSE_CLAIM && !FORCE_ISSUE) return 0;
  // 免费池的状态会变（模型下架 / 额度用尽）：每轮都试着刷一次强档 patch，
  // registryStats 自带 TTL（DSH_STATS_TTL_MS，默认 10 分钟），所以只有过期时才会真跑 fm.py。
  prepareStrongPatch();
  const spent = todaySpendCny();
  if (spent >= DAY_MAX_CNY) {
    log(`今日估算花费 ${formatCny(spent)} 已达上限 ${formatCny(DAY_MAX_CNY)}，今天不再领取新任务（DSH_DAY_MAX_CNY 可调）`);
    // 一天只通知一次：日闸一旦触发，每轮轮询都会走到这里，不按日去重就是每分钟一次弹窗。
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    if (DAYCAP_NOTIFIED !== day) {
      DAYCAP_NOTIFIED = day;
      notifyEvent({
        kind: 'daycap',
        why: `今日估算花费 ${formatCny(spent)} 已达上限 ${formatCny(DAY_MAX_CNY)}，今天不再领取新任务`,
        cny: spent,
      });
    }
    pauseClaim(`今日估算花费 ${formatCny(spent)} 已达上限 ${formatCny(DAY_MAX_CNY)}`);
    return 0;
  }
  // --issue 单跑直接按号取：列表接口带 labels 过滤时，新建 issue 偶尔索引未跟上会返回空
  // （2026-11-08 22:52 实测 #106 刚建好就查不到），单号点查没有这个问题。
  const raw = FORCE_ISSUE
    ? (await api('GET', `/repos/${REPO}/issues/${FORCE_ISSUE}`)).data
    : (await api('GET', `/repos/${REPO}/issues?labels=${encodeURIComponent('agent:ready')}&state=open&per_page=20`)).data;
  let issues = [];
  // 2026-11-09 双闸（原单闸只信 author_association，MEMBER/只读协作者也能把一条 issue
  // 变成 Administrator 侧动作）：①作者是 OWNER / 仓库协作者写权限表 / 白名单；
  // ②agent:ready 必须由可信的人亲手贴上（issues/{n}/events 的 labeled 事件 actor）。
  const trusted = await trustedLogins();
  for (const i of (Array.isArray(raw) ? raw : [raw]).filter(
    (x) => x && !x.pull_request && !(x.labels ?? []).some((l) => l.name === 'agent:working' || l.name === 'agent:done'),
  )) {
    const a = isTrustedAuthor(i, process.env.DSH_TRUSTED_AUTHORS || '', trusted);
    if (!a.ok) { log('[author-gate] #' + i.number + ' 跳过：' + a.why); continue; }
    let ev;
    try { ev = await fetchAgentReadyEvents(i.number); }
    catch (e) { log(`[author-gate] #${i.number} 跳过：读不到贴标事件（${e.message}）`); continue; }
    const l = isTrustedLabeler(ev.events, trusted, process.env.DSH_TRUSTED_AUTHORS || '', ev.truncated);
    if (!l.ok) { log('[author-gate] #' + i.number + ' 跳过：' + l.why); continue; }
    issues.push(i);
  }
  if (FORCE_ISSUE) {
    issues = issues.filter((i) => i.state === 'open' && (i.labels ?? []).some((l) => l.name === 'agent:ready'));
    if (!issues.length) {
      log(`--issue ${FORCE_ISSUE}：不是 open + agent:ready（已领取/已挂起），本轮跳过`);
      return 0;
    }
  }
  if (issues.length === 0) {
    log('没有待处理任务');
    return 0;
  }
  const runnable = [];
  for (const issue of issues) {
    const dep = await depsSatisfied(issue);
    if (dep.ok) runnable.push(issue);
    else log(`[dep] #${issue.number} 在等 ${dep.dep} 关闭，本轮跳过`);
  }
  issues.length = 0;
  issues.push(...runnable);
  if (issues.length === 0) {
    log('待处理任务都被依赖门挡住了');
    return 0;
  }
  log(`发现 ${issues.length} 个待处理任务（并发上限 ${CONCURRENCY}）`);
  await mapPool(issues, CONCURRENCY, async (issue) => {
    if (DRY) { log(`[dry-run] would run #${issue.number} ${issue.title}`); return; }
    RUNNING_TASKS += 1;
    try {
      await runTask(issue);
    } finally {
      RUNNING_TASKS -= 1;
    }
  });
  return issues.length;
}

// ---------- CI 失败回环 ----------
// agent 在 worktree 里自己跑 verify.sh 通过了，但云端 CI 仍可能因环境差异红掉。
// 这里监听 open PR 的 agent/* 分支，CI 失败就拉日志回灌给 agent 重修，上限 MAX_ATTEMPTS 次。

async function collectFailureLog(runId) {
  let text = '';
  try {
    const { data: jobs } = await api('GET', `/repos/${REPO}/actions/runs/${runId}/jobs`);
    for (const j of (jobs?.jobs ?? []).filter((x) => x.conclusion === 'failure')) {
      const failedSteps = (j.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name).join(', ');
      text += `### job: ${j.name}（失败步骤: ${failedSteps || '未知'}）\n`;
      const r = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${j.id}/logs`, {
        headers: { Authorization: `Bearer ${token()}`, 'User-Agent': 'dsh-dispatch' },
        redirect: 'follow',
      });
      if (r.ok) {
        const body = await r.text();
        text += body.slice(-6000) + '\n';
      } else {
        text += `(日志拉取失败 http=${r.status})\n`;
      }
    }
  } catch (e) {
    text += `(收集日志出错: ${e.message})\n`;
  }
  return text || '(CI 日志为空)';
}

async function repairCI(pr, issueN, runInfo) {
  const branch = pr.head.ref;
  const tag = `[issue #${issueN}][ci-retry]`;
  const wt = path.join(WT_ROOT, `issue-${issueN}-ci`);
  log(`${tag} CI 失败 run=${runInfo.id}，开始自动修复`);

  const logText = await collectFailureLog(runInfo.id);
  const t0 = Date.now();
  const prior = formatPriorFailures(logText, FAIL_STORE);
  const priorBlock = prior ? `\n## 历史同类失败（调度器记忆库）\n${prior}\n` : '';

  try {
    await setupWorktree(branch, wt, `origin/${branch}`);

    const prompt = `GitHub 云端 CI 在分支 ${branch} 上失败了（对应 issue #${issueN}）。注意：本地 verify.sh 可能是绿的，失败来自环境差异，必须先复现再修。
${priorBlock}

## 失败日志（尾部）
\`\`\`
${logText.slice(-8000)}
\`\`\`

## 要求
1. 先读仓库根目录的 AGENTS.md。
2. 在本地复现失败：运行 \`bash scripts/verify.sh\`。
3. 修复**根因**；禁止为了让 CI 变绿而放宽/删除测试断言，禁止改 .github/workflows/*，禁止新增依赖。
4. 修好后必须确认 \`bash scripts/verify.sh\` 通过。
5. 不要执行 git commit / git push —— 调度器会处理。
6. 不许留调试或占位代码。实测出现过：坏行 \`export const BROKEN = (\` 被「把括号补全」变成 \`export const BROKEN = 0;\` 而不是删掉——根因该删就删，别让它变合法留下来。

现在开始。`;

    const r = await runHeadless(wt, prompt, { PATH: CHILD_PATH }, TIMEOUT);
    const secs = Math.round((Date.now() - t0) / 1000);
    log(`${tag} headless 结束 exit=${r.code} ${secs}s`);

    const status = await worktreeStatus(wt);
    if (!status) throw new Error('CI 修复未产生任何改动');

    const gate = await verifyWorktree(wt);
    if (!gate.ok) {
      // CI 修复轮也走同一条规矩：环境失败不打回「重写」，直接带标记抛上去让外层暂停/挂起。
      const fe = gate.env ? { found: false } : parseFirstError(gate.raw ?? gate.detail);
      const err = new Error(`CI 修复后门禁未通过：${gate.detail.slice(0, 800)}${fe.found ? `\nFIRST_ERROR: ${formatFirstError(fe)}` : ''}`);
      if (gate.env) err.env = true;
      throw err;
    }

    await run(GIT, ['add', '-A'], { cwd: wt });
    const c = await run(GIT, ['-c', 'user.name=dsh-agent', '-c', 'user.email=agent@dsh.local', ...SAFE_HOOKS,
      'commit', '-m', `agent: fix CI for issue #${issueN}`], { cwd: wt });
    if (c.code !== 0) throw new Error(`commit 失败: ${c.err.trim()}`);

    // 修复提交同样过语义评审：CI 变绿不等于满足验收（修 CI 时很容易顺手把断言改弱）。
    const review = reviewAfterCommit(wt, 'HEAD~1');
    if (!review.ok) throw new Error(review.detail);

    const { data: issueData } = await api('GET', `/repos/${REPO}/issues/${issueN}`);
    const spec = parseSections(issueData?.body);
    const rdiff = collectDiff(wt, 'HEAD~1');
    const rsem = rdiff.ok
      ? await reviewWithPanel({
        issueNumber: issueN, title: issueData?.title ?? '',
        goal: pick(spec, '目标'), acceptance: pick(spec, '验收标准'), constraints: pick(spec, '约束'),
        diffText: rdiff.text, files: rdiff.files,
      })
      : {
        ok: false, verdict: 'block',
        findings: [{ severity: 'block', rule: 'semantic-diff-failed', file: null, message: `拿不到 diff：${rdiff.error}` }],
        model: '-',
      };
    log(`${tag} 语义评审：${formatSemantic(rsem).split('\n')[0]}（${(rdiff.files ?? []).length} 个文件）`);
    if (rsem.paidUsed) log(`${tag} ⚠ 语义评审切到付费面板（免费模型 ${rsem.freeModel} 不可用：${rsem.escalatedFrom}）`);
    if (!rsem.ok) throw new Error(`语义评审拒绝（修复未推送）：\n${formatSemantic(rsem)}`);

    await pushWithRetry(wt, `${branch}:${branch}`);

    await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
      body: `🔧 CI 失败自动修复完成（run ${runInfo.id}，耗时 ${secs}s），已推送新提交到 ${branch}。\n\n<!-- ci-retry-run:${runInfo.id} -->`,
    }).catch(() => {});
    log(`${tag} 修复完成 ${secs}s`);
  } catch (e) {
    // 环境失败不是这张 PR 的错：不进失败指纹、不对外报成「代码没修好」，
    // 但要把 env 标记继续传上去（外层看到 e.env 会走环境重试/挂起，而不是判这单写错）。
    const envFail = e?.env === true || /(^|\n)ENV_FAIL:|\bspawn EPERM\b/.test(String(e?.message || e));
    if (!envFail) {
      try {
        recordFailure({ text: logText, issue: issueN, attempt: 1, reason: `CI 修复失败：${e.message}` }, FAIL_STORE);
      } catch { /* 记账失败不影响主流程 */ }
      await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
        body: `⚠️ CI 失败自动修复未成功：${String(e.message).slice(0, 800)}\n\n<!-- ci-retry-run:${runInfo.id} -->`,
      }).catch(() => {});
      log(`${tag} 修复失败: ${e.message}`);
    } else {
      // 不抛：CI 修复是轮询里的旁路动作，抛出去会把常驻循环打断。下一轮 CI 仍然红、
      // 环境好了之后自然会再修一次，不需要在这里重试。
      log(`${tag} 修复被环境挡住（不记失败指纹、不报成代码失败）：${String(e.message).split('\n')[0]}`);
    }
  } finally {
    await locked(() => git(['worktree', 'remove', '--force', wt])).catch(() => {});
  }
}

// 分支落后 main 且真的冲突时，CI 那套修不了（推送前就 405）。自动 rebase 一次：
// 干净 rebase → force-with-lease 推回分支，CI 会重跑；真冲突 → 评论 + agent:failed 转人工。
// 冲突只落在基线文件时，以前是在合并后的测试上自动跑 `--bless` 重算再折进提交。
// v3 P1（docs/89 §3.1）：`--bless` 已移出自动流程——改基线等于改门禁判据，不能让调度器
// 或 agent 自证；只能人工确认后作为独立步骤重算。所以这里直接转人工，不再自动改基线。
async function resolveBaselineOnlyRebase(wt, files) {
  return {
    ok: false,
    needHuman: true,
    reason: `基线文件冲突（${files.join(', ')}）：--bless 已移出自动流程，需人工执行 `
      + '`bash scripts/verify.sh --bless` 并提交基线后重新 rebase',
  };
}

// 源码文件真冲突时，让 agent 来解一次：两边功能都要保留、门禁通过（基线只报告、不重算）。
// 只有它解不了才转人工——这样并行 PR 改同一个文件不会永远卡在人手上。
async function resolveConflictsWithAgent(wt, issueN, files) {
  const prompt = `分支 rebase 到最新 main 时发生了冲突，你只负责解决冲突，不要做别的功能改动。

冲突文件：${files.join(', ')}

## 要求
1. 先读仓库根目录的 AGENTS.md，了解门禁和禁止事项。
2. 运行 \`git rebase origin/main\`。冲突时逐个文件手工合并：**两边的功能都要保留**（main 上已有的函数/测试，本分支新增的函数/测试，一个都不许丢），不许为了让冲突消失而删掉任何一侧。
3. 解决后 \`git add <文件>\`，再 \`git -c core.editor=true rebase --continue\`；如果又出现冲突，继续同样处理，直到 rebase 完成。
4. rebase 完成后跑一次 \`bash scripts/verify.sh\` 确认通过。**不要跑 \`--bless\`**：基线是门禁判据，调度器和 agent 都不能自证（v3 P1，docs/89 §3.1）。如果失败原因只是基线数字变了（scripts/test-baseline.txt / assert-baseline.txt），停下来，在输出里列出需要人工重算的基线项，不要自己改基线。
5. 不要 \`git push\`、不要开 PR，调度器会处理。
6. 如果保留两边功能后确实无法解决，停下来，在输出里说明是哪个文件、为什么，不要硬删代码。

现在开始。`;

  const t0 = Date.now();
  // 解多文件源码冲突是这条流水线里最难的一步：29B 实测一次 41 秒成功、一次 522 秒失败，
  // 所以默认换强模型（可用 DSH_REBASE_MODEL=weak 退回旧行为）。
  const rebasePatch = (S4_ON || process.env.DSH_REBASE_MODEL === 'weak') ? '' : STRONG_PATCH;
  if (S4_ON) log(`[issue #${issueN}][rebase] 低权隔离：不用 .secrets 强模型，走本地免费档`);
  const rebaseEnv = { PATH: CHILD_PATH };
  if (rebasePatch) {
    rebaseEnv.DSH_HEADLESS_PATCH = rebasePatch;
    // 解冲突这一步显式用强模型，因此显式 opt-in 允许入口注入该路由需要的 key；
    // 这是全流程里唯一默认就会碰凭据的路径（见 docs/headless.md）。
    rebaseEnv.DSH_HEADLESS_ALLOW_CREDS = '1';
  }  const r = await runHeadless(wt, prompt, rebaseEnv, REBASE_AGENT_TIMEOUT_MS);
  const secs = Math.round((Date.now() - t0) / 1000);
  // 解冲突是最容易「跑很久还没结论」的一步，输出必须留档，否则事后只剩一行 exit=1。
  const outPath = path.join(LOG_DIR, `issue-${issueN}-rebase.log`);
  try {
    writeFileSync(outPath, `# ${new Date().toISOString()} exit=${r.code} ${secs}s\n\n## stdout\n${r.out}\n\n## stderr\n${r.err}\n`);
  } catch { /* 留档失败不影响判定 */ }
  log(`[issue #${issueN}][rebase] 冲突解决 agent 结束 exit=${r.code} ${secs}s`);
  // 失败时把这行尾巴带进 issue 评论，人工接手不用再翻机器上的日志。
  const tail = `${(r.err || '').trim()}\n\n${(r.out || '').trim()}`.trim().slice(-800);

  const left = (await run(GIT, ['diff', '--name-only', '--diff-filter=U'], { cwd: wt })).out.trim();
  if (left) return { ok: false, tail, reason: `仍有未解决冲突：${left.replace(/\n/g, ', ')}` };

  const rebaseDir = (await run(GIT, ['rev-parse', '--git-path', 'rebase-merge'], { cwd: wt })).out.trim();
  if (rebaseDir && existsSync(path.resolve(wt, rebaseDir))) {
    return { ok: false, tail, reason: 'rebase 仍停在半途（agent 没有走完 rebase --continue）' };
  }

  const status = await worktreeStatus(wt);
  if (status) {
    await run(GIT, ['add', '-A'], { cwd: wt });
    const amend = await run(GIT, [...SAFE_HOOKS, 'commit', '--amend', '--no-edit'], { cwd: wt });
    if (amend.code !== 0) return { ok: false, tail, reason: `解冲突后的改动 amend 失败：${amend.err.trim().slice(0, 200)}` };
  }
  return { ok: true };
}

async function rebaseAgentBranch(pr, issueN) {
  const branch = pr.head.ref;
  const wt = path.join(WT_ROOT, `issue-${issueN}-rebase`);
  const tmpBranch = `tmp/rebase-${issueN}`;
  const tag = `[issue #${issueN}][rebase]`;
  log(`${tag} 分支与 main 冲突，尝试自动 rebase`);
  try {
    await locked(async () => {
      await fetchWithRetry();
    });

    await locked(async () => {
      await git(['worktree', 'remove', '--force', wt]);
      await git(['branch', '-D', tmpBranch]);
      const add = await git(['worktree', 'add', wt, '-b', tmpBranch, `origin/${branch}`]);
      if (add.code !== 0) throw new Error(`worktree add 失败: ${add.err.trim()}`);
    });

    const rb = await run(GIT, ['rebase', 'origin/main'], { cwd: wt });
    if (rb.code !== 0) {
      const conflictsRaw = (await run(GIT, ['diff', '--name-only', '--diff-filter=U'], { cwd: wt })).out;
      const cls = classifyConflicts(conflictsRaw.split('\n'));

      // v3 P1（docs/89 §3.1）：基线文件冲突也不再自动修 —— `--bless` 已移出自动流程，
      // 改基线等于改门禁判据，只能人工确认后作为独立步骤重算再 rebase。
      if (cls.kind === 'baseline-only') {
        log(`${tag} 冲突只在基线文件（${cls.files.join(', ')}），不自动 --bless，转人工`);
        const resolved = await resolveBaselineOnlyRebase(wt, cls.files);
        if (resolved.ok) {
          log(`${tag} 基线已重算，继续跑门禁`);
        } else {
          await run(GIT, ['rebase', '--abort'], { cwd: wt }).catch(() => {});
          await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
            body: `⚠️ 分支 ${branch} 自动 rebase 时遇到基线冲突，需人工处理：${resolved.reason}\n\n<!-- auto-rebase:${pr.head.sha} -->`,
          }).catch(() => {});
          await api('POST', `/repos/${REPO}/issues/${issueN}/labels`, { labels: ['agent:failed'] }).catch(() => {});
          log(`${tag} 基线冲突转人工：${resolved.reason.replace(/\n/g, ' ')}`);
          return;
        }
      } else {
        // 源码文件冲突：先让 agent 解一次（两边功能都要保留），解不了才转人工。
        const conflicts = cls.files.join(', ');
        await run(GIT, ['rebase', '--abort'], { cwd: wt }).catch(() => {});
        log(`${tag} 源码冲突（${conflicts}），交给 agent 解一次`);
        const resolved = await resolveConflictsWithAgent(wt, issueN, cls.files);
        if (!resolved.ok) {
          await run(GIT, ['rebase', '--abort'], { cwd: wt }).catch(() => {});
          await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
            body: `⚠️ 分支 ${branch} 与 main 冲突，自动 rebase 失败（冲突文件：${conflicts || '未知'}；${resolved.reason}），需人工处理。\n\n<details><summary>解冲突 agent 输出（末 800 字）</summary>\n\n\`\`\`\n${resolved.tail || '（无输出）'}\n\`\`\`\n\n</details>\n\n<!-- auto-rebase:${pr.head.sha} -->`,
          }).catch(() => {});
          await api('POST', `/repos/${REPO}/issues/${issueN}/labels`, { labels: ['agent:failed'] }).catch(() => {});
          log(`${tag} 冲突解决失败，转人工：${conflicts} / ${resolved.reason.replace(/\n/g, ' ')}`);
          return;
        }
        log(`${tag} 冲突已由 agent 解决，继续跑门禁`);
      }
    }

    const gate = await verifyWorktree(wt);
    if (!gate.ok) {
      const fe = gate.env ? { found: false } : parseFirstError(gate.raw ?? gate.detail);
      const err = new Error(`rebase 后门禁未通过：${gate.detail.slice(0, 800)}${fe.found ? `\nFIRST_ERROR: ${formatFirstError(fe)}` : ''}`);
      if (gate.env) err.env = true; // 环境问题不该被记成「这个 PR 坏了」，外层据此挂起而不是判红
      throw err;
    }

    // v3 P1：rebase 后的 HEAD 是新提交（rebase/amend 改写了 commit），旧 witness 不再覆盖它，
    // 所以必须在 push 前重新签发，否则 pushWithRetry 的断言会拒推。
    const proof = attestCommit({
      repoDir: wt, issue: issueN, stdout: gate.stdout, gateBytes: gate.gate_bytes_sha256, chainFile: WITNESS_FILE,
      privateKeyPath: WITNESS_SIGNING ? WITNESS_KEY : null, keyId: WITNESS_KEY_ID,
    });
    if (!proof.ok) throw new Error(`证据签发失败（不 push 未签名证据）：${proof.why}`);
    log(`${tag} witness ${proof.witness.hash.slice(0, 12)}：commit ${proof.witness.commit.slice(0, 8)} tree ${proof.witness.tree_after.slice(0, 8)}`);

    await pushWithRetry(wt, `${tmpBranch}:${branch}`, ['--force-with-lease']);

    await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
      body: `🔄 分支 ${branch} 已自动 rebase 到最新 main，CI 会重跑。\n\n<!-- auto-rebase:${pr.head.sha} -->`,
    }).catch(() => {});
    log(`${tag} 自动 rebase 完成，已推送`);
  } catch (e) {
    // 环境挡住 rebase（沙箱/网络）与「分支真冲突」是两件事：前者不留 agent:failed 判红，
    // 只记一行日志，等环境恢复后的下一轮再 rebase。
    if (e?.env === true) log(`${tag} 自动 rebase 被环境挡住（不判失败）：${String(e.message).split('\n')[0]}`);
    else log(`${tag} 自动 rebase 出错：${String(e.message).split('\n')[0]}`);
  } finally {
    await locked(() => git(['worktree', 'remove', '--force', wt])).catch(() => {});
  }
}

// GitHub 的 mergeable_state 是懒计算的：刚推送过、或它自己还没算完时返回 'unknown'，
// 靠它决定「要不要 rebase」会漏掉真实的冲突（实测 #52 挂了几小时一直是 dirty，调度器一次都没触发）。
// 所以自己做一次本地探测：fetch 分支后用 merge-tree 试合，冲突文件一目了然。
// headless 的进程链是 bash -> dsh.cmd -> Electron。实测偶发 0xC0000142（DLL 初始化失败）：
// 3 秒退出、stdout/stderr 全空、什么都没做。这是「进程没起来」，不该耗掉一次重试预算，
// 所以在这里原地重试几次；真的起不来才把 NTSTATUS 交给上层分类。
// 只放行与凭据无关的变量。agent 是被 issue 正文（不可信输入）驱动的，
// 它拿到的环境里不该有任何能推代码或调付费接口的密钥。
const SCRUB_ENV = /^(GIT_TOKEN|GIT_ASKPASS|GIT_SSH_COMMAND|GIT_SSH_VARIANT|GH_TOKEN|GITHUB_TOKEN|SILICONFLOW_API_KEY|ZHIPU_API_KEY|LEMONADE_HOME_API_KEY|HINDSIGHT_API_TOKEN|DEEPSEEK_API_KEY)$/i;
function scrubbedEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUB_ENV.test(k)) out[k] = v;
  return out;
}

// clean=true 的子进程只拿到显式给的环境。Windows 的 bash.exe 少了 SystemRoot 会在加载 DLL 时
// 直接 0xC0000142（初始化失败），日志里只剩「子进程启动失败 exit=3221225794」再重试三次。
// 这些不是凭据，是进程能起来的生存变量，显式带上。
const WIN_KEEP = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'];
function winEnv() {
  const out = {};
  for (const k of WIN_KEEP) if (process.env[k]) out[k] = process.env[k];
  return out;
}

export async function runHeadless(cwd, prompt, env, timeout) {
  // S4 低权通道（docs/77 §8）：默认先以 dsh-agent 身份跑（agent 不继承本进程的任何凭据）；DSH_S4_AGENT=0 显式关掉。
  // 只有「通道本身不可用」（没写出 done.json：没有 dsh-agent 密码、launcher 起不来）才回退原来的 bash
  // spawn —— 隔离装坏了不该让整条流水线停摆；任务自己失败（有 done.json、exit≠0）照常上报，不回退。
  if (process.env.DSH_S4_AGENT !== '0') {
    // S4 下代理 token 经 job.env 白名单传给低权 runner（真 key 不进去）。
    const r = await runAsAgent({ task: prompt, cwd, timeoutSec: Math.round(timeout / 1000), patch: env.DSH_HEADLESS_PATCH || '', env: { DSH_PROXY_TOKEN: env.DSH_PROXY_TOKEN || '' } });
    if (r.done) {
      const usage = sumUsage(r.out);
      if (!r.ok) log(`[s4] 低权 run 失败 exit=${r.code}：${r.error || ''}`);
      else log(`[s4] 低权 run 完成 user=${r.done.user || '?'} ${r.done.durationSec ?? '?'}s`);
      return { code: r.code, out: finalText(r.out), raw: r.out, usage, s4: true, err: r.error || '' };
    }
    // 2026-11-09 审计：这里的静默回退就是"隔离装坏了 → 全部以 Administrator 跑 agent"，等于洞原地复活。
    // 默认 fail-closed（按环境失败计，不耗重试预算）；只有显式 DSH_S4_FALLBACK=admin 才回退，且留告警。
    log(`[s4] 低权通道不可用：${r.error || '没有 done.json'}`);
    const act = s4FallbackAction(process.env.DSH_S4_FALLBACK, r.error);
    if (act.fail) {
      const e = new Error(act.error);
      e.env = true;
      throw e;
    }
    log(`[s4] ⚠ ${act.warning}`);
    notifyEvent({ kind: 's4-fallback', why: act.warning.slice(0, 160) });
  }
  let last = null;
  for (let i = 1; i <= 3; i += 1) {
    // --json：stdout 是事件流，里面带每一步的 usage（headless profile 没装 cost-meter，
    // 账本里看不到这些 run，只能自己从事件流里累加）。
    // 显式给空串：防止调度器进程自己环境里的 DSH_HEADLESS_PATCH / DSH_HEADLESS_ALLOW_CREDS 漏给 agent
    // （否则「默认无凭据」会被继承来的环境变量悄悄破坏，那是条看不见的凭据泄漏路径）。
    last = await run(BASH, [path.join(REPO_DIR, 'ci/headless-task.sh'), '-'], { cwd, input: prompt, timeout, env: { ...winEnv(), ...scrubbedEnv(), DSH_INSTALL: INSTALL_DIR, ...env, DSH_HEADLESS_JSON: '1', DSH_HEADLESS_PATCH: env.DSH_HEADLESS_PATCH || '', DSH_HEADLESS_ALLOW_CREDS: env.DSH_HEADLESS_ALLOW_CREDS || '' }, clean: true });
    if (Number(last.code) < 0xC0000000) {
      const usage = sumUsage(last.out);
      return { ...last, raw: last.out, usage, out: finalText(last.out) };
    }
    log(`[headless] 子进程启动失败 exit=${last.code}（Windows NTSTATUS），5 秒后重试 ${i}/3`);
    if (i < 3) await new Promise((r) => setTimeout(r, 5000));
  }
  return last;
}

// 「agent 到底改了什么」的唯一入口：.dsh/PLAN.md 是调度器自己写的工作笔记（已加进 info/exclude），
// 万一 exclude 没生效也不能把它当成 agent 的改动——#60 就因此把一次进程崩溃误判成「干了活但验收失败」。
async function worktreeStatus(wt) {
  const out = (await run(GIT, ['status', '--porcelain'], { cwd: wt })).out;
  return out
    .split(NL)
    .filter((line) => line.trim() && !/(^|\s)\.dsh\//.test(line.trim()))
    .join(NL)
    .trim();
}

async function branchConflictFiles(branch) {
  const f = await git(['fetch', 'origin', branch, '--quiet']);
  if (f.code !== 0) return null; // 网络问题：这一轮先不判
  const r = await run(GIT, ['merge-tree', '--write-tree', '--name-only', 'origin/main', `origin/${branch}`], { cwd: REPO_DIR });
  if (r.code === 0) return [];
  // 第一行是合并后的 tree oid，之后是冲突文件；其它输出（例如 hint）忽略。
  return r.out
    .split('\n')
    .slice(1)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('CONFLICT') && !s.includes(' '));
}

// 每天（本地时间早 7 点之后）把失败指纹蒸馏一份写进 Hindsight，供三台机器共享。
// 放在常驻进程里做：不用另建计划任务、不用提权，也不需要额外的登录凭据。
const DISTILL_MARKER = path.join(LOG_DIR, 'distill.last');
const DISTILL_HOUR = Number(process.env.DSH_DISTILL_HOUR ?? 7);
async function maybeDistill() {
  try {
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    const date = bj.toISOString().slice(0, 10);
    if (bj.getUTCHours() < DISTILL_HOUR) return;
    if (existsSync(DISTILL_MARKER) && readFileSync(DISTILL_MARKER, 'utf8').trim() === date) return;
    writeFileSync(DISTILL_MARKER, date);
    const r = await run(process.execPath, [path.join(REPO_DIR, 'ci', 'distill-failures.mjs')], {
      cwd: REPO_DIR, timeout: 300000,
      env: { ...scrubbedEnv(), PATH: CHILD_PATH },
    });
    // stdout 尾巴取两行：两次投递（失败摘要 → pipeline::failures、池子统计 → pipeline::pool）
    // 各打一行 [distill]，只留最后一行的话「失败摘要写入」永远看不到。
    const outTail = (r.out || '').trim().split(NL).filter(Boolean).slice(-2).join(' | ');
    // 失败时把子进程 stderr 的尾巴一起打进日志：2026-11-01~11-08 连续 8 天 exit=1 却没留任何原因，
    // 凭据缺失 / 服务不通 / 写入被拒三种情况完全分不清。
    const errTail = r.code === 0 ? '' : ` stderr=${((r.err || '').trim().split(NL).filter(Boolean).slice(-2).join(' | ') || '(空)').slice(0, 300)}`;
    log(`[distill] 每日写入 Hindsight exit=${r.code}${errTail} ${outTail.slice(0, 300)}`);
    // 顺手生成成本报表：数据就在本地 usage.jsonl，多跑一次 node 不到 0.2 秒。
    const cr = await run(process.execPath, [path.join(REPO_DIR, 'ci', 'cost-report.mjs')], {
      cwd: REPO_DIR, timeout: 120000, env: { ...scrubbedEnv(), PATH: CHILD_PATH },
    });
    log(`[cost] 成本报表 exit=${cr.code} ${(cr.out || '').trim().slice(0, 160)}`);
    // 免费池健康：钱是次要的，池子挂了才是真的停工。每天把非 ok 的模型点名一次。
    try {
      const stats = registryStats(true);
      const entries = Object.entries(stats || {});
      // stale 能用（只是要重试），单独计数；真正要留意的是 down / degraded / unknown / suspect。
      const stale = entries.filter(([, v]) => String(v?.status ?? 'unknown') === 'stale').length;
      const bad = entries.filter(([, v]) => !['ok', 'stale'].includes(String(v?.status ?? 'unknown')));
      if (!entries.length) log('[pool] 读不到免费池快照（fm.py stats 不可用）');
      else log(`[pool] ${entries.length} 个模型，ok ${entries.length - stale - bad.length} 个、stale ${stale} 个${bad.length ? '；需要留意：' + bad.slice(0, 8).map(([m, v]) => `${m}=${v?.status ?? 'unknown'}`).join('、') + (bad.length > 8 ? `…等 ${bad.length} 个` : '') : ''}`);
    } catch (e) { log(`[pool] 读免费池失败：${e.message}`); }
  } catch (e) { log(`[distill] 失败：${e.message}`); }
}

async function checkAgentPRs() {
  const { data: prs } = await api('GET', `/repos/${REPO}/pulls?state=open&per_page=20`);
  const agentPrs = (Array.isArray(prs) ? prs : []).filter((pr) => /^agent\/issue-(\d+)$/.test(pr.head.ref));
  if (agentPrs.length) {
    const states = [];
    for (const pr of agentPrs) {
      const { data: d } = await api('GET', `/repos/${REPO}/pulls/${pr.number}`);
      states.push(`#${pr.number}:${d?.mergeable_state ?? 'unknown'}`);
    }
    log(`[prs] 打开 ${agentPrs.length} 个 agent PR：${states.join(' ')}`);
  }
  for (const pr of Array.isArray(prs) ? prs : []) {
    const m = /^agent\/issue-(\d+)$/.exec(pr.head.ref);
    if (!m) continue;
    const issueN = Number(m[1]);
    const { data: comments } = await api('GET', `/repos/${REPO}/issues/${issueN}/comments?per_page=100`);
    const list = Array.isArray(comments) ? comments : [];

    // 冲突分支：CI 修不了（推送前就 405），先尝试自动 rebase。
    // 同一个提交最多试 3 次——工具修好之后还有机会重试，但不会每分钟空转。
    if (DRY) {
      log(`[dry-run] [prs] #${pr.number}（${pr.head.ref}）跳过 rebase / CI 修复 / 自动合并`);
      continue;
    }
    const rebaseTries = list.filter((c) => c.body?.includes(`auto-rebase:${pr.head.sha}`)).length;
    const conflicts = await branchConflictFiles(pr.head.ref);
    if (conflicts && conflicts.length && rebaseTries < REBASE_MAX_TRIES) {
      await rebaseAgentBranch(pr, issueN);
      continue;
    }

    const { data: runs } = await api('GET', `/repos/${REPO}/actions/runs?branch=${encodeURIComponent(pr.head.ref)}&per_page=5`);
    const ci = ((runs?.workflow_runs) ?? []).find((r) => r.name === 'ci' && r.status === 'completed');
    // CI 绿 + 分支可合并时的出口：默认停下等人工合并（产品调研里没有一家自动合并），
    // 但工单打了 merge:auto 就按约定自动 squash 合并并关单——这是唯一一条「无人值守跑到底」的路径。
    if (ci && ci.conclusion === 'success') {
      const { data: issueData } = await api('GET', `/repos/${REPO}/issues/${issueN}`);
      const labels = (issueData?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
      const mergeState = (await api('GET', `/repos/${REPO}/pulls/${pr.number}`))?.data?.mergeable_state;
      // 五个门：仓库白名单 → merge:auto 标签 → 评审未降级 → CI 绿 → 可合并（clean）。
      // 白名单从环境变量来，不从仓库内文件读：agent 改得动仓库，读仓库内配置等于让它自己发权限。
      const decision = decideAutoMerge({
        repo: REPO,
        allowlist: AUTO_MERGE_ALLOWLIST,
        labels,
        body: pr.body,
        ciConclusion: ci.conclusion,
        mergeState,
      });
      if (!decision.ok) {
        if (decision.code === 'repo-not-allowed') {
          log(`[issue #${issueN}][prs] #${pr.number} CI 绿（${mergeState ?? 'unknown'}），仓库 ${REPO} 不在自动合并白名单，等人工合并`);
          continue;
        }
        if (decision.code === 'no-label') {
          log(`[issue #${issueN}][prs] #${pr.number} CI 绿（${mergeState ?? 'unknown'}），等人工合并（未打 merge:auto）`);
          continue;
        }
        if (decision.code === 'review-degraded') {
          log(`[issue #${issueN}][prs] #${pr.number} 语义评审降级（团未凑够/缺失），不自动合并，等人工`);
          notifyEvent({ kind: 'review-degraded', issue: issueN, why: `PR #${pr.number} 的语义评审降级，已跳过 merge:auto` });
          continue;
        }
        // ruleset 要求分支是最新的（strict_required_status_checks_policy），落后的 PR 即使 CI 绿也合不了：
        // 这类「behind」没有冲突文件，merge-tree 查不出来，只能在这里按状态补一次 rebase。
        if (decision.code === 'merge-behind' && rebaseTries < REBASE_MAX_TRIES) {
          log(`[issue #${issueN}][prs] #${pr.number} 落后于 main（ruleset 要求最新），先 rebase`);
          await rebaseAgentBranch(pr, issueN);
          continue;
        }
        log(`[issue #${issueN}][prs] #${pr.number} ${decision.why}，本轮不合并`);
        continue;
      }
      const merged = await api('PUT', `/repos/${REPO}/pulls/${pr.number}/merge`, {
        merge_method: 'squash',
        commit_title: `${issueData.title} (#${issueN})`,
      });
      if (!(merged.status >= 200 && merged.status < 300)) {
        log(`[issue #${issueN}][prs] 自动合并失败：${JSON.stringify(merged.data).slice(0, 200)}`);
        continue;
      }
      log(`[issue #${issueN}][prs] 已按 merge:auto 合并 #${pr.number} → ${String(merged.data.sha).slice(0, 7)}`);
      // 合并完顺手镜像到 Gitee（国内拉代码快）；镜像失败只记日志，不影响主流程。
      try {
        const mirror = await run(BASH, [path.join(REPO_DIR, 'ci', 'mirror-gitee.sh')], {
          cwd: REPO_DIR, timeout: 120000,
          env: { PATH: CHILD_PATH, DSH_GIT: GIT, DSH_SECRETS_DIR: SECRETS_DIR },
        });
        if (mirror.code !== 0) log(`[gitee] 镜像失败（不影响 GitHub）：${mirror.err.trim().slice(0, 120)}`);
      } catch (e) { log(`[gitee] 镜像出错：${e.message}`); }
      await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
        body: `✅ 已按 \`merge:auto\` 自动 squash 合并 PR #${pr.number}（commit ${String(merged.data.sha).slice(0, 7)}）。`,
      }).catch(() => {});
      await api('DELETE', `/repos/${REPO}/git/refs/heads/${pr.head.ref}`).catch(() => {});
      await api('PATCH', `/repos/${REPO}/issues/${issueN}`, { state: 'closed' }).catch(() => {});
      continue;
    }
    if (!ci || ci.conclusion !== 'failure') continue;
    if (list.some((c) => c.body?.includes(`ci-retry-run:${ci.id}`))) continue; // 这个 run 已处理过

    const attempts = list.filter((c) => c.body?.includes('CI 失败自动修复')).length;
    if (attempts >= MAX_ATTEMPTS) {
      await api('POST', `/repos/${REPO}/issues/${issueN}/labels`, { labels: ['agent:failed'] }).catch(() => {});
      await api('POST', `/repos/${REPO}/issues/${issueN}/comments`, {
        body: `❌ CI 失败修复已达 ${MAX_ATTEMPTS} 次上限，需人工介入。\n\n<!-- ci-retry-run:${ci.id} -->`,
      }).catch(() => {});
      log(`[issue #${issueN}] CI 修复次数超限，转人工`);
      continue;
    }
    await repairCI(pr, issueN, ci);
  }
}

// 调度器重启后，上一个进程可能留下 agent:working 的孤儿 issue；启动时清掉，
// 否则这些 issue 会因为"正在执行"被永久跳过。
async function cleanupStaleWorking() {
  // --dry-run 不能改远端：这里会 DELETE 别人的 agent:working 标签。
  if (DRY) { log('[dry-run] 跳过孤儿 agent:working 清理'); return; }
  const { data } = await api('GET', `/repos/${REPO}/issues?labels=${encodeURIComponent('agent:working')}&state=open&per_page=50`);
  for (const i of Array.isArray(data) ? data : []) {
    if (i.pull_request || i.labels.some((l) => l.name === 'agent:done')) continue;
    await api('DELETE', `/repos/${REPO}/issues/${i.number}/labels/${encodeURIComponent('agent:working')}`).catch(() => {});
    log(`清理孤儿 agent:working → issue #${i.number}`);
  }
}

// 拉起脱离父进程的常驻 --serve。父进程退出后它继续跑（工具调用进程树被回收也不该带走它，
// 所以真正的补位动作交给计划任务里的 --once）。
function startResident() {
  const child = spawn(process.execPath, ['--use-system-ca', SELF, '--serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: REPO_DIR,
    env: { ...process.env, DSH_DISPATCH_CHILD: '1' },
  });
  child.unref();
  return child.pid;
}

// 周期性状态对账：标签 ↔ 本地（每 DSH_RECONCILE_EVERY 轮一次，默认 30）。
// 只报警不改远端——同一份标签可能是另一台机器在跑，自动摘标会把那边正在干的任务抢掉。
let RECONCILE_TICK = 0;
let LAST_SNAPSHOT_AT = 0;
// 池子快照本身要起 python，别每轮都跑：默认一小时一次（DSH_POOL_SNAPSHOT_EVERY_MS 可调，0=关）。
async function maybePoolSnapshot() {
  const everyMs = Number(process.env.DSH_POOL_SNAPSHOT_EVERY_MS ?? 3600 * 1000);
  if (!Number.isFinite(everyMs) || everyMs <= 0) return;
  if (Date.now() - LAST_SNAPSHOT_AT < everyMs) return;
  LAST_SNAPSHOT_AT = Date.now();
  try { await poolSnapshot(); } catch (e) { log(`[pool] 快照失败：${e.message}`); }
}
let LAST_DRIFT_KEY = '';
async function reconcileState() {
  RECONCILE_TICK += 1;
  const every = Number(process.env.DSH_RECONCILE_EVERY ?? 30);
  if (!Number.isFinite(every) || every <= 0 || RECONCILE_TICK % every !== 0) return;
  const r = await api('GET', `/repos/${REPO}/issues?labels=${encodeURIComponent('agent:working')}&state=open&per_page=50`);
  if (r.status !== 200 || !Array.isArray(r.data)) {
    log(`[state] 对账读不到 open 工单（status=${r.status}），本轮跳过`);
    return;
  }
  const working = r.data
    .filter((i) => !i.pull_request && !(i.labels ?? []).some((l) => l?.name === 'agent:done'))
    .map((i) => i.number);
  let dirs = [];
  try { dirs = existsSync(WT_ROOT) ? readdirSync(WT_ROOT) : []; } catch { dirs = []; }
  const drift = localDrift({ working, worktrees: parseWorktreeDirs(dirs), active: [...ISSUE_SESSION.keys()] });
  const key = JSON.stringify({ l: drift.orphanLabels, w: drift.orphanWorktrees });
  if (key === LAST_DRIFT_KEY) return; // 同一批不一致不重复刷屏/重复弹窗
  LAST_DRIFT_KEY = key;
  if (drift.ok) { log('[state] 对账通过：标签与本地状态一致'); return; }
  log(`[state] ⚠ 状态不一致：${formatDrift(drift)}`);
  notifyEvent({ kind: 'state-drift', why: formatDrift(drift) });
}

// 残留工作树巡检：WT_ROOT 下的 issue-N 目录对不上任何 open 工单时，只记一行日志。
// 不自动删（未提交改动会跟着没），也不进轮询循环（工作树不会每分钟长一个）。
async function auditStaleWorktrees() {
  if (!existsSync(WT_ROOT)) return;
  let dirs = [];
  try { dirs = readdirSync(WT_ROOT); } catch { return; }
  if (!parseWorktreeDirs(dirs).length) return;
  let open = [];
  const r = await api('GET', `/repos/${REPO}/issues?state=open&per_page=100`);
  if (r.status !== 200 || !Array.isArray(r.data)) {
    log(`[worktrees] 读不到 open 工单（status=${r.status}），跳过巡检`);
    return;
  }
  open = r.data.map((i) => i.number);
  const dirty = {};
  for (const d of parseWorktreeDirs(dirs)) {
    if (open.includes(d.n)) continue;
    const st = await git(['-C', path.join(WT_ROOT, d.dir), 'status', '--porcelain'], { cwd: REPO_DIR });
    dirty[d.dir] = st.code !== 0 || Boolean(String(st.out ?? '').trim());
  }
  for (const line of formatAudit(auditWorktrees({ dirs, openNumbers: open, dirty }))) log(line);
}

// ---------- 免费池探活（手动，不自动跑）----------
// stale 不等于坏：它只是「上次失败过、还没再试」，而强档选型只看 ok。探一遍能把可用面拉回来，
// 但它要连网、要花几分钟，所以做成手动命令，绝不进轮询路径。
function freeModelsDir() {
  return process.env.DSH_FREE_MODELS_DIR || path.join(homedir(), '.dsh', 'tools', 'free-models');
}

function runFm(script, args, timeout) {
  return spawnSync('python', [path.join(freeModelsDir(), script), ...args], { encoding: 'utf8', timeout, windowsHide: true });
}

function readPoolStats() {
  const r = runFm('fm.py', ['stats', '--json'], 60000);
  if (r.status !== 0) {
    log(`[probe] 读池子状态失败（exit=${r.status}）：${String(r.stderr || '').trim().slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(String(r.stdout || '{}'));
  } catch (e) {
    log(`[probe] 池子状态不是 JSON：${e.message}`);
    return null;
  }
}


// 登记表的两个用途：① `free === false` 的付费面——probe.py 不带 --include-paid 会整组 continue；
// ② kind 表——`video` 在 probe.py 里直接记「跳过（未纳入自动巡检）」，任何 flag 都不会测。
// 两者不筛，就是「选中 N 个、实际 0 个」的空转（按 id 排最前的恰好全是这批）。
function readRegistry() {
  const file = path.join(freeModelsDir(), 'free-models.json');
  try {
    const reg = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(reg) ? reg : Array.isArray(reg.models) ? reg.models : [];
    if (!list.length) {
      log(`[probe] 登记表 ${file} 里没有模型条目，本轮不筛付费/kind`);
      return null;
    }
    const paid = new Set();
    const kinds = new Map();
    for (const m of list) {
      if (!m || !m.id) continue;
      if (m.free === false) paid.add(String(m.id));
      if (m.kind) kinds.set(String(m.id), String(m.kind));
    }
    return { paid: paid.size ? paid : null, kinds };
  } catch (e) {
    log(`[probe] 读登记表失败（${file}）：${e.message}，本轮不筛付费/kind`);
    return null;
  }
}

async function poolSnapshot() {
  const stats = readPoolStats();
  if (!stats) return 1;
  const rec = { at: new Date().toISOString(), ...poolCounts(stats) };
  try {
    const dir = path.dirname(POOL_SNAPSHOT_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(POOL_SNAPSHOT_FILE, `${JSON.stringify(rec)}${NL}`, 'utf8');
  } catch (e) {
    log(`[pool] 快照写入失败：${e.message}`);
    return 1;
  }
  log(`[pool] ${rec.ok} ok / ${rec.stale} stale / ${rec.suspect} suspect / ${rec.unknown} unknown / ${rec.down} down（共 ${rec.total}）→ ${POOL_SNAPSHOT_FILE}`);
  return 0;
}

async function probeStale() {
  const stats = readPoolStats();
  if (!stats) return 1;
  const includePaid = (process.env[INCLUDE_PAID_ENV] ?? '0') === '1';
  const reg = readRegistry();
  const paidIds = includePaid ? null : reg && reg.paid;
  const plan = planProbe(stats, {
    limit: Number(process.env.DSH_PROBE_LIMIT ?? 8),
    paid: paidIds ? (id) => paidIds.has(id) : null,
    kindOf: reg ? (id) => reg.kinds.get(id) ?? null : null,
  });
  const ids = plan.picked;
  if (!ids.length) {
    log(
      `[probe] 没有可探的免费 stale/unknown 模型（共 ${plan.total} 个，stale ${plan.stale}，付费跳过 ${plan.skippedPaid}，不可探 video/image ${plan.skippedKind}${
        includePaid ? '' : `；要探付费设 ${INCLUDE_PAID_ENV}=1`
      }）`,
    );
    return 0;
  }
  if (DRY) {
    log(`[dry-run] [probe] 会探活 ${ids.length} 个：${ids.join(', ')}`);
    return 0;
  }
  log(
    `[probe] 选中 ${ids.length} 个（stale ${plan.stale}，免费候选 ${plan.candidates}，付费跳过 ${plan.skippedPaid}，不可探 video/image ${plan.skippedKind}${
      includePaid ? '，已含付费' : ''
    }）：${ids.join(', ')}`,
  );
  const r = runFm('probe.py', probeArgv(ids, { includePaid }), Number(process.env.DSH_PROBE_TIMEOUT_MS ?? 15 * 60 * 1000));
  for (const line of summarizeProbe(r.stdout)) log(`[probe] ${line}`);
  if (r.status !== 0) {
    log(`[probe] probe.py 退出码 ${r.status}：${String(r.stderr || '').trim().slice(0, 200)}`);
    return r.status ?? 1;
  }
  const after = readPoolStats();
  if (after) {
    const models = listModels(after);
    log(`[probe] 探活后：${models.filter((m) => m.status === 'ok').length}/${models.length} 个模型 ok`);
  }
  return 0;
}

// ---------- 多库：每库一个独立常驻 ----------
// 只做一层「挨个 --ensure」：子进程靠 DSH_REPO / DSH_LOG_DIR / DSH_WORKTREES 变成另一个库的常驻。
// 这样单库路径一行没改，隔离却是真的（各自的锁文件、日志、工作树目录）。
function ensureRepos() {
  const file = path.resolve(REPOS_FILE);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    log(`[repos] 读不出清单 ${file}：${e.message}`);
    return 1;
  }
  const { entries, errors } = parseRepos(raw, { baseDir: path.dirname(file) });
  for (const err of errors) log(`[repos] 跳过 ${err}`);
  if (!entries.length) {
    log('[repos] 清单里没有可用的库');
    return 1;
  }
  for (const line of formatPlan(entries)) log(`[repos] ${line}`);
  let failed = 0;
  for (const entry of entries) {
    if (!existsSync(entry.dir)) {
      log(`[repos] ${entry.repo} 的目录不存在：${entry.dir}`);
      failed += 1;
      continue;
    }
    const r = spawnSync(process.execPath, [SELF, '--ensure'], {
      cwd: entry.dir,
      env: childEnv(entry),
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter(Boolean).slice(-1)[0] || '(无输出)';
    log(`[repos] ${entry.repo}：${out}`);
    if (r.status !== 0) failed += 1;
  }
  return failed ? 1 : 0;
}

async function main() {
  // 运行态三件放在最前面：`--status` 必须只读（不拿锁、不补标签、不调 API、绝不进轮询）；
  // 未知旗标直接拒绝。以前多打一个旗标不报错，会静默掉进 `while (true)` 起一个常驻调度器。
  if (RUNTIME.conflict) {
    console.error(`同一行给了多个命令：${RUNTIME.conflict}——一次只做一件，否则会静默丢掉前一个（例如 --pause --status 实际不会暂停）`);
    process.exitCode = 2;
    return;
  }
  if (RUNTIME.unknown.length) {
    console.error(`未知旗标：${RUNTIME.unknown.join(' ')}\n可用：--once --ensure --serve --dry-run --unattended --probe-stale --pool-snapshot --repos <file> --status --pause --resume --help`);
    process.exitCode = 2;
    return;
  }
  if (RUNTIME.cmd === 'status') {
    LOG_READONLY = true; // 只读体检：连日志文件都不写（见 log 的注释）
    const st = readState(LOG_DIR);
    // 闸门 3（docs/security-remediation-20261109.md §七）：S4 覆盖率只能从落盘事实算——
    // exec-audit 的每次低权执行 + events.jsonl 里的 s4-fallback（显式回退才留痕）。
    let audit = [];
    try { audit = parseAudit(readFileSync(execAuditPath(), 'utf8')); } catch { /* 没跑过就没有审计文件 */ }
    let fallbackEvents = 0;
    try { fallbackEvents = countFallbackEvents(readFileSync(EVENTS_FILE, 'utf8')); } catch { /* 没有事件文件＝没有回退记录 */ }
    const s4Status = summarizeS4Coverage({ audit, fallbackEvents });
    for (const line of formatStatus({
      mode: PAUSE_CLAIM ? 'paused' : 'ready',
      lock: statusLock(),
      st,
      spendCny: todaySpendCny(),
      dayMaxCny: DAY_MAX_CNY,
      taskMaxCny: TASK_MAX_CNY,
      s4: formatS4Coverage(s4Status),
      events: recentKinds(3),
      repo: REPO,
      autoMerge: AUTO_MERGE_ALLOWLIST,
    })) console.log(line);
    return;
  }
  if (RUNTIME.cmd === 'pause') {
    const why = RUNTIME.why || '人工暂停（--pause 未给 --why）';
    try { setPaused(LOG_DIR, why); } catch (e) {
      // 落盘失败就是「暂停没生效」：不能只打日志然后返回 0，人以为停了、机器还在领单。
      console.error(`暂停未生效（写 .logs/state.json 失败）：${e.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`已暂停：${why}（写入 .logs/state.json；常驻进程下一轮轮询起不再领新单，已跑的活不中断）`);
    return;
  }
  if (RUNTIME.cmd === 'resume') {
    const st = readState(LOG_DIR);
    clearPaused(LOG_DIR);
    console.log(st.paused ? `已恢复（原暂停原因：${st.pausedWhy || '未写'}；常驻进程下一轮轮询起恢复领单）` : '本来就没暂停（状态文件已重置）');
    return;
  }
  if (RUNTIME.cmd === 'help') {
    console.log('用法：node ci/dispatch.mjs [--once|--ensure|--serve|--dry-run|--probe-stale|--pool-snapshot|--repos <file>|--status|--pause|--resume]');
    console.log('  --status  只读体检：锁、暂停态、今日花费；不领单、不常驻');
    console.log('  --pause   持久暂停（.logs/state.json），重启后仍然停着；--why 记原因');
    console.log('  --resume  解除暂停');
    return;
  }
  if (POOL_SNAPSHOT) {
    process.exitCode = await poolSnapshot();
    return;
  }
  if (REPOS_FILE) {
    process.exitCode = ensureRepos();
    return;
  }
  if (PROBE_STALE) {
    process.exitCode = await probeStale();
    return;  }
  // --ensure：只负责「保证有一个人在跑」。要么报出已经有的那个，要么脱离父进程拉起一个
  // 常驻的 --serve。它自己不等任务、不持锁，所以登录自启/计划任务反复调用都安全。
  if (ENSURE) {
    const holder = lockHolder();
    if (holder) {
      console.log(`常驻调度器已在运行（pid=${holder.pid}，起于 ${holder.at}）`);
      return;
    }
    console.log(`已拉起常驻调度器（pid=${startResident()}）`);
    return;
  }

  // 计划任务每 5 分钟用 --once 敲门。--ensure 手动拉起的常驻进程挂在当前工具调用的进程树上，
  // 工具调用一结束就可能被回收（03:15 就是这样丢的），所以这里顺手补位：没有活着的常驻进程
  // 就拉起一个，然后让位给它轮询。补位失败才退回单轮执行。
  if (ONCE && !FORCE_ISSUE && !lockHolder()) {
    let pid = null;
    try {
      pid = startResident();
      log(`拉起常驻调度器（pid=${pid}），本轮交给它轮询`);
    } catch (e) {
      log(`拉起常驻调度器失败，本轮按单轮执行：${e.message}`);
    }
    if (pid) {
      await new Promise((r) => setTimeout(r, 1200));
      if (lockHolder()) return;
      log('常驻进程没拿到锁，本轮自己跑一遍');
    }
  }

  // --issue 单跑是 operator 显式点名的一单：pass3 先 --pause 让常驻不再领新单，但常驻仍持有
  // 调度锁（它只是不领单），这里若照常抢锁会被静默挡回；单跑不写锁，跑完也不留锁。
  const lock = FORCE_ISSUE ? { ok: true, release() {} } : acquireLock();
  if (!lock.ok) {
    // 计划任务每 5 分钟拿 --once 来敲门，常驻进程在跑时不该刷日志
    if (!ONCE) log(`已有调度器在跑（pid=${lock.holder.pid} 起于 ${lock.holder.at}），本次直接退出`);
    return;
  }
  process.on('exit', lock.release);
  // 心跳与轮询循环解耦：pollOnce 阻塞期间也要续租（见 LOCK_BEAT_INTERVAL_MS 注释）。
  // 被接管后（ownsLock 为假）立刻停表，别去写别人的锁。
  let beatTimer = null;
  if (!ONCE) {
    beatTimer = setInterval(() => {
      try {
        if (!ownsLock()) { clearInterval(beatTimer); beatTimer = null; return; }
        writeFileSync(LOCK_FILE, JSON.stringify(lockPayload({ pid: process.pid, at: new Date().toISOString(), mode: 'serve' })));
      } catch { /* 刷不动就等下一次 */ }
    }, LOCK_BEAT_INTERVAL_MS);
    beatTimer.unref?.();
    process.on('exit', () => { try { clearInterval(beatTimer); } catch { /* 退出中 */ } });
  }
  // 代码指纹：出问题时第一个要回答的是「跑的是哪份代码」。只有 pid 时，日志里分不清
  // 是旧进程还在跑，还是改了代码没重启。sha 取仓库 HEAD，时间取本文件 mtime（UTC）。
  let codeSha = 'nogit';
  try {
    const r = spawnSync(GIT, ['rev-parse', '--short', 'HEAD'], { cwd: REPO_DIR, encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout) codeSha = r.stdout.trim();
  } catch { /* 不是 git 仓库就退回 nogit */ }
  let codeAt = '?';
  try { codeAt = new Date(statSync(fileURLToPath(import.meta.url)).mtime).toISOString().slice(5, 16).replace('T', ' '); } catch { /* 读不到就算了 */ }
  log(`调度器启动 repo=${REPO} mode=${ONCE ? 'once' : 'serve'} dry=${DRY} maxAttempts=${MAX_ATTEMPTS} code=${codeSha}@${codeAt}Z pid=${process.pid}`);
  // 标签要先存在，否则后面所有「打标签」都是静默无效的。放在轮询之前、只跑一次。
  try { await ensureLabels(); } catch (e) { log(`[labels] 补齐出错：${e.message}`); }
  prepareStrongPatch();
  const pruned = pruneLogs();
  try {
    const archivedSessions = await pruneDeadSessions();
    if (archivedSessions) log(`归档 ${archivedSessions} 个已删 worktree 的会话（移到 sessions-archived/pipeline-old）`);
  } catch (e) { log(`会话归档跳过：${e.message}`); }
  if (pruned) log(`清理 ${pruned} 个超过 ${LOG_RETENTION_DAYS} 天的尝试日志`);
  try { await auditStaleWorktrees(); } catch (e) { log(`[worktrees] 巡检出错：${e.message}`); }
  if (!existsSync(ASKPASS)) throw new Error(`缺少 ${ASKPASS}`);
  await cleanupStaleWorking();
  // 先看有没有「池子恢复后该放回去」的挂起单，再领新任务：恢复的单本来就排过队。
  try { await recoverBlocked(); } catch (e) { log(`[blocked] 恢复流程出错：${e.message}`); }
  await pollOnce();
  await checkAgentPRs();
  // --dry-run 在文档里是「只看一眼」，不该像常驻进程一样每分钟轮询下去。
  if (ONCE || DRY) return;
  while (true) {
    await new Promise((r) => setTimeout(r, INTERVAL));
    // 常驻进程要确认锁还是自己的：卡死超过 LOCK_STALE_MS 后会被别人接管，
    // 那时自己必须退出，不能变成两个调度器同时抢 worktree。
    if (!ownsLock()) {
      log(`锁已被接管（pid=${process.pid} 不再是持有者），常驻进程退出`);
      return;
    }
    // 心跳由上面的独立定时器负责（跑单期间也要续租）；这里只确认锁还是自己的。
    // 先写池子快照再蒸馏：distill 读的是同一份 jsonl，顺序反了会读到上一小时的窗口。
    try { await maybePoolSnapshot(); } catch (e) { log(`[pool] 快照出错：${e.message}`); }
    await maybeDistill();
    try {
      await recoverBlocked();
      await pollOnce();
      await checkAgentPRs();
      await reconcileState();
    } catch (e) { log(`轮询出错: ${e.message}`); }
  }
}

// 允许「只加载、不执行」：模块级错误（漏声明的常量、TDZ、拼错的导入）在 import 时就会炸，
// 而 `node --check` 只查语法，抓不到这类问题（2026-10-26 就因为删了一个 const 让 main 起不来）。
if (process.env.DSH_DISPATCH_LOAD_ONLY !== '1') {
  main().catch((e) => { console.error(e); process.exit(1); });
}
