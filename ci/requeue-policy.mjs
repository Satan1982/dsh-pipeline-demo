// agent:blocked 的自动恢复判据（2026-11-08 起只看云端）。
//
// 历史：以前重投前还要问本地 Lemonade 的 LLM 槽位（单槽位会被 Hindsight 的 9B 顶掉，
// 导致重投出去必然再挂一次、白烧重投预算）。
// 用户裁决「这个新方案以后都停用本地大模型了」后，本地档、/health 探活与预热一并删除；
// 重投只看云端免费池或付费档。等待是免费的，白跑一次不是。
//
// 这里只做纯判断，HTTP 与快照留给调用方：好写好测。

/** 重投判据（纯函数）：云端通道可用就重投，否则等下一档退避。 */
export function decideRequeue({ paid, cloud }) {
  if (paid && cloud?.ok) return { ok: true, why: `付费档可用（${cloud.why}）` };
  if (cloud?.ok) return { ok: true, why: `云端可用（${cloud?.why}）` };
  return { ok: false, why: `云端：${cloud?.why ?? '未知'}` };
}
