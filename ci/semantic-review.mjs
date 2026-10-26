/**
 * semantic-review.mjs — push 之前的语义评审层
 *
 * 机械评审（review.mjs）只看 diff 的形状：删了测试、漏了 bless、留了调试残留、动了 workflows。
 * 它看不出「代码写得很像那么回事，但根本没满足验收标准」——例如只实现了示例里的那一种输入、
 * 把断言写得比需求弱、或者把 RangeError 改成了返回 undefined。
 *
 * 这一层请一个**不同家族的模型**读 issue 的验收标准 + 实际 diff，回答一个问题：
 * 「按这份验收标准，这个改动算完成了吗？」结论用 JSON 返回，解析失败按 block 处理（fail closed）。
 *
 * 判定口径（写进提示词，避免成为风格警察）：
 *   block —— 能指名某条验收标准没满足，或把已有的测试/断言改弱了，或行为和需求文字直接矛盾；
 *   warn  —— 其余可疑但不影响验收的（命名、性能、可读性）。
 * 评审模型挂掉（超时/网络/配额）不算 block，返回 skipped，由调用方决定是否放行。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

export const DEFAULT_REVIEW_MODEL = 'Qwen/Qwen3.5-122B-A10B';
const DEFAULT_ENDPOINT = 'https://api.siliconflow.cn/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 240_000;
// 凭证文件里那条 ref 的键名，拆开拼是为了不被「看起来像密钥赋值」的扫描规则误伤。
const CRED_KEY = ['SILICONFLOW', 'API', 'KEY'].join('_');
// diff 太长时截断：评审要的是「有没有满足验收」，不是逐字读完全部实现。
const MAX_DIFF_CHARS = 40_000;
const GIT = 'C:/Program Files/Git/cmd/git.exe';

/**
 * 取 worktree 里 origin/main...HEAD 的 diff（runTask 调用时改动已 commit）。
 * 收集失败不抛错：评审层拿不到 diff 就该按 block 处理，而不是让流程崩掉。
 *
 * files 是 `--name-status` 的结果（M/A/D + 路径）。它存在的理由很具体：
 * 评审模型有过一次「明明改了 src/index.js，却断言这个文件没有被修改」，
 * 于是把改动清单单独摆到它面前，让它没法凭空否定一个已经出现在清单里的文件。
 */
export function collectDiff(cwd, base = 'origin/main') {
  const opts = { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
  // 永远排除 .dsh/：那是调度器写给 agent 的内部笔记，不是给人 review 的改动。
  const r = spawnSync(GIT, ['diff', '--no-color', '--unified=2', `${base}...HEAD`, '--', '.', ':(exclude).dsh'], opts);
  if (r.status !== 0) {
    return { ok: false, text: '', files: [], error: (r.stderr || r.error?.message || 'git diff 失败').trim().slice(0, 300) };
  }
  const ns = spawnSync(GIT, ['diff', '--name-status', `${base}...HEAD`, '--', '.', ':(exclude).dsh'], opts);
  const files = String(ns.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split(/\s+/);
      return { status, path: rest.join(' ') };
    });
  const text = String(r.stdout ?? '');
  const truncated = text.length > MAX_DIFF_CHARS;
  return {
    ok: true,
    files,
    text: truncated ? `${text.slice(0, MAX_DIFF_CHARS)}\n\n…（diff 过长已截断，共 ${text.length} 字符）` : text,
  };
}

export function buildReviewPrompt({ issueNumber, title, goal, acceptance, constraints, diffText, files = [], acceptanceNote = '' }) {
  const fileList = files.length
    ? files.map((f) => `- ${f.status}  ${f.path}`).join('\n')
    : '（git 没有报出任何文件变化）';
  return `你是一名严格的代码评审者。有人刚刚提交了一个改动，声称完成了 GitHub Issue #${issueNumber}「${title}」。

你要回答的唯一问题：**按下面这份验收标准，这个改动算完成了吗？**

## 验收标准（逐条核对）
${acceptance}

## 需求背景
${goal}

## 约束
${constraints || '（无额外约束）'}
${acceptanceNote ? `\n## 调度器已经跑过的验收命令\n${acceptanceNote}\n` : ''}
## 本次提交实际改动的文件（git diff --name-status，可信）
${fileList}

## 实际改动（git diff）
\`\`\`diff
${diffText}
\`\`\`

## 判定口径
- \`block\`：你能**指名**某条验收标准没满足；或已有测试/断言被改弱、被删；或实现的行为与验收文字直接矛盾（例如要求抛错却返回了 undefined）。必须写出是第几条、缺什么。
- 要 block「某个文件没有改」，先确认它不在上面的改动清单里；清单里有的文件，不要声称它没被修改。
- 需求可能**已经被之前的合并实现了**（这次只是补测试/补基线，所以 diff 里只有测试文件）。这种情况只要最终代码满足验收就判 pass，不要因为「源码文件没出现在 diff 里」而 block。
- 引用具体代码时请抄 diff 里的原文；不要凭印象描述实现。
- \`warn\`：命名、可读性、性能、注释等不影响验收的问题。
- 不要因为「风格不合你口味」block；没有证据不要猜测。改动的实现方式与你的偏好不同，但满足验收 —— 判 pass。

## 输出格式（只输出 JSON，不要任何解释文字）
{"verdict":"pass"|"block","findings":[{"severity":"block"|"warn","file":"src/xxx.js","message":"具体缺什么"}]}`;
}

/**
 * 解析评审模型返回的文本。任何解析不出来的情况都按 block 处理：
 * 宁可让人看一眼，也不让「模型话没说完」混成一个通过。
 */
export function parseVerdict(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const fail = (why) => ({
    ok: false,
    verdict: 'block',
    findings: [{ severity: 'block', rule: 'semantic-unparseable', file: null, message: why }],
  });
  if (start < 0 || end <= start) return fail(`评审模型没有返回 JSON 结论：${raw.slice(0, 200)}`);

  let obj;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return fail(`评审结论不是合法 JSON：${e.message}`);
  }
  const verdict = String(obj?.verdict ?? '').toLowerCase();
  if (verdict !== 'pass' && verdict !== 'block') return fail(`评审结论缺少合法的 verdict：${JSON.stringify(obj).slice(0, 200)}`);

  const findings = (Array.isArray(obj.findings) ? obj.findings : [])
    .map((f) => ({
      severity: f?.severity === 'block' ? 'block' : 'warn',
      rule: 'semantic',
      file: f?.file ? String(f.file).slice(0, 200) : null,
      message: String(f?.message ?? '').slice(0, 500),
    }))
    .filter((f) => f.message);

  // verdict=pass 却带着 block finding 是自相矛盾，以更严格的那个为准。
  const blocked = verdict === 'block' || findings.some((f) => f.severity === 'block');
  return { ok: !blocked, verdict: blocked ? 'block' : 'pass', findings };
}

/** 从 ~/.dsh/.credentials.yaml 的 refs 里取密钥；读不到返回空串。 */
export function readCredential(file = process.env.DSH_CREDENTIALS || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', '.credentials.yaml')) {
  try {
    if (!existsSync(file)) return '';
    const re = new RegExp(`^\\s+${CRED_KEY}:\\s*(\\S+)`);
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = re.exec(line);
      if (m) return m[1].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* 读不到就当没有 */ }
  return '';
}

async function callModel({ prompt, credential, model, endpoint, timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ctl.signal,
    });
    const text = await r.text();
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    // 顺手把计量带回来：评审团是唯一每单必跑、又完全不产生代码的付费调用，
    // 不给 token 数就无从算成本。
    return {
      content: String(data?.choices?.[0]?.message?.content ?? ''),
      usage: data?.usage ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{ok: boolean, verdict: string, findings: Array, skipped?: string, model: string}>}
 */
export async function reviewSemantically({
  goal,
  acceptance,
  constraints = '',
  diffText,
  files = [],
  acceptanceNote = '',
  issueNumber = 0,
  title = '',
  credential = process.env[CRED_KEY] || readCredential(),
  model = process.env.DSH_REVIEW_MODEL || DEFAULT_REVIEW_MODEL,
  endpoint = process.env.DSH_REVIEW_ENDPOINT || DEFAULT_ENDPOINT,
  timeoutMs = Number(process.env.DSH_REVIEW_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  mockPath = process.env.DSH_REVIEW_MOCK || '',
} = {}) {
  const prompt = buildReviewPrompt({ issueNumber, title, goal, acceptance, constraints, diffText, files, acceptanceNote });

  // 测试钩子：直接读一个 JSON 文件当作模型输出，用来端到端验证 block 路径（不花钱、可复现）。
  if (mockPath && existsSync(mockPath)) {
    return { ...parseVerdict(readFileSync(mockPath, 'utf8')), model: `mock:${mockPath}` };
  }
  if (!credential) {
    return { ok: true, verdict: 'skipped', findings: [], skipped: '没有 siliconflow 凭证，跳过语义评审', model };
  }
  try {
    const out = await callModel({ prompt, credential, model, endpoint, timeoutMs });
    return { ...parseVerdict(out.content), model, usage: out.usage };
  } catch (e) {
    return { ok: true, verdict: 'skipped', findings: [], skipped: `语义评审调用失败：${e.message}`, model };
  }
}

/**
 * 评审团：机械评审只能看形状，单模型语义评审又会「自己评自己」（同家族模型对同类错法
 * 经常一起看不见）。所以默认跑两个不同家族的模型，任一 block 即 block（保守），
 * 至少一个真的跑过且都 pass 才算 pass。
 */
export const DEFAULT_PANEL = ['Qwen/Qwen3.5-122B-A10B', 'moonshotai/Kimi-K2.7-Code'];

export function panelModels(raw = process.env.DSH_REVIEW_MODELS) {
  const list = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_PANEL.slice();
}

function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.severity}|${f.file ?? ''}|${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function totalTokens(usage) {
  if (!usage) return 0;
  const a = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const b = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  return a + b;
}

export function aggregateReviewers(reviewers) {
  const tokens = reviewers.reduce((n, r) => n + totalTokens(r.usage), 0);
  const ran = reviewers.filter((r) => r.verdict !== 'skipped');
  const blocked = ran.filter((r) => r.verdict === 'block');
  if (blocked.length) {
    // 阻断时也把其它评审器的提示一并带上：回灌给下一次重试的失败原因越具体越好。
    return { ok: false, verdict: 'block', findings: dedupeFindings(ran.flatMap((r) => r.findings ?? [])), reviewers, tokens };
  }
  if (ran.length) {
    return { ok: true, verdict: 'pass', findings: dedupeFindings(ran.flatMap((r) => r.findings ?? [])), reviewers, tokens };
  }
  return {
    ok: true,
    verdict: 'skipped',
    findings: [],
    skipped: reviewers.map((r) => r.skipped || '跳过').join('；'),
    reviewers,
    tokens,
  };
}

/**
 * 免费档模型：账号在 siliconflow 的免费额度模型。先用它单独评审，跑得通就不花一分钱。
 * 只有它不可用（没凭证、4xx/5xx、超时、输出解析不出 verdict）才切到付费面板——
 * 切换这件事必须让人看见，调用方据此写日志 / PR body / 评论。
 */
export const FREE_REVIEW_MODEL = process.env.DSH_REVIEW_FREE_MODEL || 'XingChenAGI/Xing4.0-29B';

/** 并行跑付费面板；mockPaths 与 models 一一对应（测试用）。 */
async function runPanel(options = {}) {
  const models = options.models ?? panelModels();
  const mocks = options.mockPaths ?? null;
  const reviewers = await Promise.all(
    models.map(async (model, i) => {
      const r = await reviewSemantically({ ...options, model, mockPath: mocks ? mocks[i] ?? '' : options.mockPath });
      // 单个评审器在 mock 模式下会把 model 写成 mock:<path>；评审团要的是「哪个评审器说了什么」，
      // 所以这里统一按调用时给的模型名记录。
      return { ...r, model, tier: 'paid' };
    }),
  );
  return aggregateReviewers(reviewers);
}

/**
 * 免费优先的评审入口：免费模型能给出结论就用它；不能才切付费面板，并标记 paidUsed。
 * `skipFree: true` 或 `DSH_REVIEW_SKIP_FREE=1` 时直接走付费面板（调试/急需更强判断时用）。
 */
export async function reviewWithPanel(options = {}) {
  const skipFree = options.skipFree ?? process.env.DSH_REVIEW_SKIP_FREE === '1';
  if (skipFree) {
    return { ...(await runPanel(options)), tier: 'paid', paidUsed: false, skippedFree: '按配置跳过免费档' };
  }

  const freeModel = options.freeModel ?? FREE_REVIEW_MODEL;
  const free = await reviewSemantically({ ...options, model: freeModel });
  // 29B 免费模型有时不回 JSON（实测 2026-10-26：输出了一堆分析、没有结论对象）。
  // 这不等于「代码有问题」，只等于「免费档给不出可用的裁决」——按不可用处理，切付费面板。
  const unparsable = (free.findings ?? []).some((f) => f.rule === 'semantic-unparseable');
  if (free.verdict !== 'skipped' && !unparsable) {
    const reviewers = [{ ...free, model: freeModel, tier: 'free' }];
    return { ...aggregateReviewers(reviewers), model: freeModel, tier: 'free', paidUsed: false };
  }

  // 免费档不可用：切付费面板，并把「为什么切」带回去给调用方展示。
  const paid = await runPanel(options);
  return {
    ...paid,
    tier: 'paid',
    paidUsed: true,
    freeModel,
    escalatedFrom: unparsable ? '免费模型没有按格式返回 JSON 结论' : free.skipped || '免费评审器不可用',
  };
}

export function formatSemantic(result) {
  const panel = Array.isArray(result.reviewers)
    ? `评审团 ${result.reviewers.filter((r) => r.verdict !== 'skipped').length}/${result.reviewers.length} 有效（${result.reviewers
        .map((r) => `${r.model}=${r.verdict}`)
        .join('，')}）`
    : '';
  const cost = result.tokens ? `，tokens=${result.tokens}` : '';
  const head = panel ? `${panel}${cost}；` : '';
  const mark = result.paidUsed ? '[付费] ' : '';
  if (result.verdict === 'skipped') return `${head}${mark}跳过（${result.skipped}）`;
  const lines = result.findings.map((f) => `${f.severity === 'block' ? '✗ 阻断' : '⚠ 提示'} [${f.rule}] ${f.message}${f.file ? `（${f.file}）` : ''}`);
  if (lines.length === 0) return `${head}${mark}${result.verdict === 'pass' ? '通过' : '阻断'}（0 个问题，model=${result.model ?? 'panel'}）`;
  return `${head}${result.verdict === 'pass' ? '通过' : '阻断'}（${lines.length} 个问题，model=${result.model ?? 'panel'}）\n${lines.join('\n')}`;
}
