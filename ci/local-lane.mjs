// 本地免费档（Lemonade）的槽位判断。
//
// 为什么单独一层：Lemonade 的 LLM 槽位只有 1 个（resources/defaults.json: max_models.llm=1），
// 而本机还有第二个客户端（Hindsight）会用 Qwen3.5-9B 唤醒同一个槽位。2026-11-06 实测：
// 30B 刚 load 成功 3 秒后就被 9B 顶掉（两边都是「谁后 load 谁赢」），于是流水线的
// 「预热 240s 超时 → No model loaded → 0 token」会在无人值守时反复发生。
//
// agent:blocked 的自动恢复原先只看云端免费池（fm.py 快照）：云端有 ok 模型就重投。
// 但重投出去的工单走的是本地档，本地槽位被占时它必然再失败一次、白烧一次重投预算
// （最多 3 次，一晚上就烧完，然后停在 agent:blocked:manual 等人）。
// 所以恢复判据要能问一句「本地槽位现在能不能用」。
//
// 这里只做纯判断（拿 /health 的 JSON 判槽位），HTTP 留给调用方：好写好测。

export const DEFAULT_LOCAL_MODEL = 'Qwen3-Coder-30B-A3B-Instruct-GGUF';

/** /health 的 all_models_loaded 里，type=llm 的那些（embedding 不占 LLM 槽位）。 */
export function llmEntries(health) {
  const all = health?.all_models_loaded;
  return Array.isArray(all) ? all.filter((m) => String(m?.type ?? '') === 'llm') : [];
}

/**
 * 槽位现状，三态：
 *   ready    目标模型已经在槽里（可以直接跑；busy 表示别的请求正在用它）
 *   free     LLM 槽位空着（跑之前由 headless-task.sh 的预热 load 进来）
 *   occupied 槽位被另一个 LLM 占着（再投出去就是白发一次任务）
 */
export function laneState(health, modelId = DEFAULT_LOCAL_MODEL) {
  const llms = llmEntries(health);
  const mine = llms.find((m) => String(m?.model_name ?? '') === modelId);
  if (mine) {
    return {
      state: 'ready',
      model: modelId,
      status: String(mine.status ?? ''),
      busy: mine.is_busy === true,
      pid: mine.pid ?? null,
    };
  }
  if (llms.length) {
    const holder = llms[0];
    return {
      state: 'occupied',
      holder: String(holder?.model_name ?? '未知'),
      status: String(holder?.status ?? ''),
      busy: holder?.is_busy === true,
      pid: holder?.pid ?? null,
    };
  }
  return { state: 'free', model: modelId };
}

/** 把三态翻成「能不能重投 / 为什么」，口径与 poolHealth 的 { ok, why } 一致。 */
export function laneVerdict(lane) {
  if (!lane || typeof lane !== 'object') return { ok: false, why: '本地槽位未知' };
  if (lane.state === 'ready') {
    return { ok: true, why: `本地档已加载 ${lane.model}${lane.busy ? '（正在出字，下一单会排队）' : ''}` };
  }
  if (lane.state === 'free') return { ok: true, why: `本地 LLM 槽位空闲（${lane.model} 可预热）` };
  return {
    ok: false,
    why: `本地 LLM 槽位被 ${lane.holder} 占用（${lane.status || '?'}；单槽，Hindsight 会周期性唤醒它）`,
  };
}
