// agent:blocked 的自动恢复：把「什么时候再试、什么时候放弃」做成纯函数，
// 改 label / 发评论这些网络动作留在 dispatch.mjs。
//
// 为什么需要它：免费池不可用时调度器把工单挂起成 agent:blocked 等人决定（2026-10-27 的口径，
// 不自动烧付费）。这条规则在无人值守时有个死角——池子半夜恢复了，单子却永远躺在 blocked 里。
// 于是这里补一层：按退避探活，池子恢复就自动把工单放回 agent:ready；重投有上限，
// 池子反复抖（重投后立刻又挂起）不会无限循环。

// 退避阶梯（毫秒）：5 / 10 / 20 / 40 / 60 分钟，之后固定 60 分钟一次。
export const REQUEUE_BACKOFF_MS = [5, 10, 20, 40, 60].map((m) => m * 60 * 1000);
// 同一个工单最多自动重投几次。超过就停手，改成人来处理——防止「池子抖一下就无限重跑」。
export const MAX_AUTO_REQUEUE = 3;

const iso = (ms) => new Date(ms).toISOString();
const toMs = (v) => {
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : 0;
};

/** "5,10,20,40,60"（分钟）→ 毫秒数组；非法项丢掉，全丢退回默认阶梯。 */
export function parseBackoff(raw) {
  const list = String(raw ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((m) => m * 60 * 1000);
  return list.length ? list : REQUEUE_BACKOFF_MS.slice();
}

/** 第 probes 次探活之后等多久：超出阶梯长度就停在最后一档。 */
export function backoffMs(probes, backoff = REQUEUE_BACKOFF_MS) {
  const list = Array.isArray(backoff) && backoff.length ? backoff : REQUEUE_BACKOFF_MS;
  const i = Math.min(Math.max(0, Math.floor(Number(probes) || 0)), list.length - 1);
  return list[i];
}

/** 一次挂起在本地要记什么：何时挂的、探活了几次、自动重投了几次、下次何时可探。 */
export function initialEntry({ now, why = '未知原因', requeues = 0, backoff = REQUEUE_BACKOFF_MS } = {}) {
  const t = Number(now) || Date.now();
  return {
    blockedAt: iso(t),
    why: String(why || '未知原因').slice(0, 200),
    probes: 0,
    requeues: Math.max(0, Math.floor(Number(requeues) || 0)),
    nextProbeAt: iso(t + backoffMs(0, backoff)),
    gaveUp: false,
  };
}

/** 还没到探活时间就不用花一次 fm.py。 */
export function isDue(entry, now = Date.now()) {
  if (!entry || entry.gaveUp) return false;
  return Number(now) >= toMs(entry.nextProbeAt);
}

/**
 * 这一步该做什么。
 * pool = { ok: boolean, why?: string } —— dispatch 探活免费池的结果。
 * 返回 { action, reason, probed?, entry }：
 *   skip    没有记录 / 已放弃，什么都不用做（不会写盘）
 *   wait    还没到点，或池子还没恢复；entry 已更新（探活次数 +1、下次探活时间后移）
 *   requeue 池子恢复：摘 agent:blocked、打 agent:ready；entry 里 requeues +1
 *   giveup  池子恢复了但自动重投已达上限：停止自动恢复，交给人
 */
export function recoveryDecision({ entry, now, pool, maxRequeue = MAX_AUTO_REQUEUE, backoff = REQUEUE_BACKOFF_MS } = {}) {
  const t = Number(now) || Date.now();
  if (!entry) return { action: 'skip', reason: '没有本地挂起记录' };
  if (entry.gaveUp) return { action: 'skip', reason: '已放弃自动重投，等人处理', entry };
  if (t < toMs(entry.nextProbeAt)) {
    return { action: 'wait', reason: `未到探活时间（下次 ${entry.nextProbeAt}）`, entry };
  }
  if (!pool || pool.ok !== true) {
    const probes = (Number(entry.probes) || 0) + 1;
    return {
      action: 'wait',
      probed: true,
      reason: `免费池仍不可用（${pool?.why ?? '探活失败'}）`,
      entry: {
        ...entry,
        probes,
        nextProbeAt: iso(t + backoffMs(probes, backoff)),
        lastPoolWhy: String(pool?.why ?? '探活失败').slice(0, 200),
      },
    };
  }
  const requeues = Number(entry.requeues) || 0;
  if (requeues >= Math.max(0, Number(maxRequeue))) {
    return {
      action: 'giveup',
      probed: true,
      reason: `免费池已恢复，但这张单已自动重投 ${requeues} 次仍未过，停止自动恢复`,
      entry: { ...entry, gaveUp: true, gaveUpAt: iso(t) },
    };
  }
  const probes = (Number(entry.probes) || 0) + 1;
  return {
    action: 'requeue',
    probed: true,
    reason: `免费池恢复（${pool.why ?? 'ok'}）`,
    entry: {
      ...entry,
      probes,
      requeues: requeues + 1,
      lastRequeueAt: iso(t),
      nextProbeAt: iso(t + backoffMs(probes, backoff)),
      gaveUp: false,
    },
  };
}

/**
 * 状态文件会一直长下去：删掉「很久没动过」的条目。
 * 保留已放弃的记录一段时间（人还想看为什么停的），过期再扔。
 */
export function pruneState(state, { now = Date.now(), retentionMs = 7 * 24 * 3600 * 1000 } = {}) {
  const out = {};
  const keepFrom = Number(now) - Number(retentionMs);
  for (const [key, entry] of Object.entries(state || {})) {
    const touched = Math.max(toMs(entry?.blockedAt), toMs(entry?.lastRequeueAt), toMs(entry?.gaveUpAt), toMs(entry?.nextProbeAt));
    if (touched && touched >= keepFrom) out[key] = entry;
  }
  return out;
}
