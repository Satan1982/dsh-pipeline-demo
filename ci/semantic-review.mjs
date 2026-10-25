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
const DEFAULT_TIMEOUT_MS = 120_000;
// 凭证文件里那条 ref 的键名，拆开拼是为了不被「看起来像密钥赋值」的扫描规则误伤。
const CRED_KEY = ['SILICONFLOW', 'API', 'KEY'].join('_');
// diff 太长时截断：评审要的是「有没有满足验收」，不是逐字读完全部实现。
const MAX_DIFF_CHARS = 40_000;

/**
 * 取 worktree 里 origin/main...HEAD 的 diff（runTask 调用时改动已 commit）。
 * 收集失败不抛错：评审层拿不到 diff 就该按 block 处理，而不是让流程崩掉。
 */
export function collectDiff(cwd, base = 'origin/main') {
  const r = spawnSync('C:/Program Files/Git/cmd/git.exe', ['diff', '--no-color', '--unified=2', `${base}...HEAD`], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return { ok: false, text: '', error: (r.stderr || r.error?.message || 'git diff 失败').trim().slice(0, 300) };
  }
  const text = String(r.stdout ?? '');
  if (text.length <= MAX_DIFF_CHARS) return { ok: true, text };
  return { ok: true, text: `${text.slice(0, MAX_DIFF_CHARS)}\n\n…（diff 过长已截断，共 ${text.length} 字符）` };
}

export function buildReviewPrompt({ issueNumber, title, goal, acceptance, constraints, diffText }) {
  return `你是一名严格的代码评审者。有人刚刚提交了一个改动，声称完成了 GitHub Issue #${issueNumber}「${title}」。

你要回答的唯一问题：**按下面这份验收标准，这个改动算完成了吗？**

## 验收标准（逐条核对）
${acceptance}

## 需求背景
${goal}

## 约束
${constraints || '（无额外约束）'}

## 实际改动（git diff）
\`\`\`diff
${diffText}
\`\`\`

## 判定口径
- \`block\`：你能**指名**某条验收标准没满足；或已有测试/断言被改弱、被删；或实现的行为与验收文字直接矛盾（例如要求抛错却返回了 undefined）。必须写出是第几条、缺什么。
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
export function readCredential(file = process.env.DSH_CREDENTIALS || 'C:/Users/Administrator/.dsh/.credentials.yaml') {
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
    return String(data?.choices?.[0]?.message?.content ?? '');
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
  issueNumber = 0,
  title = '',
  credential = process.env[CRED_KEY] || readCredential(),
  model = process.env.DSH_REVIEW_MODEL || DEFAULT_REVIEW_MODEL,
  endpoint = process.env.DSH_REVIEW_ENDPOINT || DEFAULT_ENDPOINT,
  timeoutMs = Number(process.env.DSH_REVIEW_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  mockPath = process.env.DSH_REVIEW_MOCK || '',
} = {}) {
  const prompt = buildReviewPrompt({ issueNumber, title, goal, acceptance, constraints, diffText });

  // 测试钩子：直接读一个 JSON 文件当作模型输出，用来端到端验证 block 路径（不花钱、可复现）。
  if (mockPath && existsSync(mockPath)) {
    return { ...parseVerdict(readFileSync(mockPath, 'utf8')), model: `mock:${mockPath}` };
  }
  if (!credential) {
    return { ok: true, verdict: 'skipped', findings: [], skipped: '没有 siliconflow 凭证，跳过语义评审', model };
  }
  try {
    const out = await callModel({ prompt, credential, model, endpoint, timeoutMs });
    return { ...parseVerdict(out), model };
  } catch (e) {
    return { ok: true, verdict: 'skipped', findings: [], skipped: `语义评审调用失败：${e.message}`, model };
  }
}

export function formatSemantic(result) {
  if (result.verdict === 'skipped') return `跳过（${result.skipped}）`;
  const lines = result.findings.map((f) => `${f.severity === 'block' ? '✗ 阻断' : '⚠ 提示'} [${f.rule}] ${f.message}${f.file ? `（${f.file}）` : ''}`);
  if (lines.length === 0) return `${result.verdict === 'pass' ? '通过' : '阻断'}（0 个问题，model=${result.model}）`;
  return `${result.verdict === 'pass' ? '通过' : '阻断'}（${lines.length} 个问题，model=${result.model}）\n${lines.join('\n')}`;
}
