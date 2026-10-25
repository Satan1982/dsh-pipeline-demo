/**
 * headless-kind.mjs — 把 agent 内部失败分类成稳定标签
 *
 * 为什么单独一个文件：dispatch.mjs 一被 import 就会跑 main()，没法在里面写单测。
 *
 * 归类依据是 headless 的 stdout/stderr 里可识别的症状，而不是退出码——
 * 29B 撞 TPM 限流时既有 exit=0 也有 exit=1，但对调度器来说是同一件事：这次没干成活。
 */

const KINDS = [
  ['llm-rate-limit', /RATE_LIMIT:\s*429|TPM limit reached/],
  ['llm-missing-credential', /MISSING_CREDENTIAL/],
  ['llm-timeout', /LLM_TIMEOUT|ETIMEDOUT|timed out after/i],
  ['agent-gate-red', /== verify: FAILED ==|拒绝：测试数量|拒绝：断言数量|拒绝：断言有新增/],
];

export function headlessKind(out, err, code) {
  const hay = `${out ?? ''}\n${err ?? ''}`;
  for (const [kind, re] of KINDS) if (re.test(hay)) return kind;
  return code === 0 ? 'agent-no-change' : `agent-exit-${code}`;
}

export const HEADLESS_KINDS = KINDS.map(([k]) => k);
