// ci/s4-coverage.mjs — `--status` 的 S4 覆盖率行（docs/security-remediation-20261109.md §七 闸门 3）。
//
// 「覆盖率」只回答一个问题：调度器跑过的命令里，有多少次真的走了低权通道。
// 数据源两处，都是既有的落盘事实：
//   ① .logs/exec-audit.jsonl —— 每次 runAsAgentCommand 一条；s4=true 表示低权进程回带了
//      done.json（通道确实跑起来了；命令本身失败也算走过通道，不算「回退」）。
//   ② events.jsonl 里 kind=s4-fallback 的事件 —— 只有显式 DSH_S4_FALLBACK=admin 才会产生，
//      出现一次就是「以 Administrator 跑了 agent 内容」，闸门 3 直接不成立。
// 失败的通道尝试不算回退：fail-closed 把单子判失败正是期望行为（§六「断 launcher 应 fail」）。
export function parseAudit(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object') rows.push(rec);
    } catch { /* 半行/损坏行跳过：审计是旁路，不能因为一行坏了就把体检打死 */ }
  }
  return rows;
}

export function countFallbackEvents(text) {
  const rows = parseAudit(text);
  return rows.filter((r) => r.kind === 's4-fallback').length;
}

export function summarizeS4Coverage({ audit = [], fallbackEvents = 0 } = {}) {
  const attempts = audit.length;
  const lowPriv = audit.filter((r) => r?.s4 === true).length;
  const succeeded = audit.filter((r) => r?.ok === true).length;
  const fallbacks = Number(fallbackEvents) || 0;
  const total = attempts + fallbacks;
  const ratePct = total === 0 ? null : Math.round((attempts / total) * 1000) / 10;
  return { attempts, lowPriv, succeeded, fallbacks, total, ratePct, ok: fallbacks === 0 };
}

export function formatS4Coverage(s) {
  if (!s) return 's4: 无数据';
  if (s.fallbacks > 0) {
    return `s4: 覆盖 ${s.ratePct ?? 0}%（${s.attempts} 次低权执行，其中成功 ${s.succeeded}；⚠ ${s.fallbacks} 次回退——闸门 3 不成立）`;
  }
  if (s.attempts === 0) return 's4: 覆盖 n/a（0 次执行，0 次回退）';
  return `s4: 覆盖 100%（${s.attempts} 次低权执行，其中成功 ${s.succeeded}；0 次回退）`;
}
