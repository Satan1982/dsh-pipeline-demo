/**
 * redact.mjs — 公开出口脱敏（P1-7，issue #242）
 *
 * 调度器把 agent / 验收命令 / 高风险适配器的原始输出贴进 issue 评论和 PR body，
 * 那两张都是公开页面。输出里只要有本机绝对路径（尤其 D:\code\.secrets\... ）或
 * token 形状，删评论也收不回来——GitHub 的通知邮件与引用已经发出去了。
 *
 * 所以脱敏挂在唯一出口（dispatch.mjs 的 api()）上，只对会公开的字段生效：
 *   1. 凭据形状 -> 固定占位符；
 *   2. 绝对路径 -> 固定占位符（相对路径不动：ci/dispatch.mjs:476 是排障信息）；
 *   3. 超长 -> 截断并写明原长。
 *
 * 本模块纯函数、无 IO，判据见 ci/redact.test.mjs。
 */

/** GitHub 单条评论上限 65536；6000 够排障，也远低于上限。 */
export const PUBLIC_TEXT_LIMIT = 6000;

/** 会公开写入的 API 路径。只认我们发出去的正文，label / 建 issue 等不受影响。 */
const PUBLIC_WRITE_PATHS = [/\/comments$/, /\/pulls$/];

/** 凭据形状（整段替换，顺序无关）。 */
const SECRET_RULES = [
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, '<私钥已隐藏>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<GitHub token 已隐藏>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<GitHub token 已隐藏>'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<密钥已隐藏>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<AWS key 已隐藏>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<Slack token 已隐藏>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g, '<JWT 已隐藏>'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1<已隐藏>'],
];

/**
 * 绝对路径：盘符 / UNC / MSYS（/d/code）/ POSIX（/home、/Users、/root）。
 * 都带「前面不是路径字符」的负向断言，避免把 URL 里 /home 之类的片段吃掉。
 */
const PATH_RULES = [
  [/[A-Za-z]:\\[^\s"'<>|)]*/g, '<路径已隐藏>'],
  [/\\\\[A-Za-z0-9._$-]+\\[^\s"'<>|)]*/g, '<路径已隐藏>'],
  [/(?<![\w:/-])\/[A-Za-z]\/[^\s"'<>|)]*/g, '<路径已隐藏>'],
  [/(?<![\w:/-])\/(?:home|Users|root|opt|srv|mnt|var\/log)\/[^\s"'<>|)]*/g, '<路径已隐藏>'],
];

/**
 * 公开文本脱敏。非字符串原样返回（调用方可能传 undefined）。
 * 幂等：对已脱敏文本再跑一次不会变（占位符不匹配任何规则）。
 */
export function redactPublic(text, { limit = PUBLIC_TEXT_LIMIT } = {}) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [re, rep] of SECRET_RULES) out = out.replace(re, rep);
  for (const [re, rep] of PATH_RULES) out = out.replace(re, rep);
  if (Number.isFinite(limit) && limit > 0 && out.length > limit) {
    out = out.slice(0, limit) + '\n\n…（已截断：全文 ' + text.length + ' 字符，公开上限 ' + limit + '）';
  }
  return out;
}

/** 这条写入是否会公开到 issue / PR 页面。 */
export function isPublicWritePath(urlPath) {
  const p = String(urlPath ?? '');
  return PUBLIC_WRITE_PATHS.some((re) => re.test(p));
}

/**
 * api() 的出口包装：只对 POST comments / POST pulls 的 body 字段脱敏，
 * 其它请求（打 label、关 issue、GET）与其它字段原样返回，避免改变请求语义。
 */
export function redactPublicPayload(method, urlPath, body) {
  if (String(method ?? '').toUpperCase() !== 'POST') return body;
  if (!body || typeof body !== 'object' || typeof body.body !== 'string') return body;
  if (!isPublicWritePath(urlPath)) return body;
  return { ...body, body: redactPublic(body.body) };
}
