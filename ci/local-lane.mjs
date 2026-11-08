// 本地免费档（Lemonade）的槽位判断。
//
// 为什么单独一层：Lemonade 的 LLM 槽位只有 1 个（resources/defaults.json: max_models.llm=1），
// 且本机还有第二个客户端（Hindsight 抽取）共用 13305。2026-11-06 曾实测 30B 被 9B 顶掉
// （谁后 load 谁赢）；2026-11-07 起两边都指 30B 且 30B pinned，该竞态消失；但槽位仍只有 1 个
// （2 slots 同属 30B），被占时流水线仍会「预热超时 → No model loaded → 0 token」，
// 所以恢复判据要能问一句「本地槽位现在能不能用」。
//
// agent:blocked 的自动恢复原先只看云端免费池（fm.py 快照）：云端有 ok 模型就重投。
// 但重投出去的工单走的是本地档，本地槽位被占时它必然再失败一次、白烧一次重投预算
// （最多 3 次，一晚上就烧完，然后停在 agent:blocked:manual 等人）。
//
// 这里只做纯判断（拿 /health 的 JSON 判槽位），HTTP 留给调用方：好写好测。

// 2026-11-07 本机实测：Lemonade 已将 Qwen3-Coder-30B（Q4_K_M，17.3GB）设为常驻并 pinned
// （ctx 32768、--parallel 2），9B 不再唤醒槽位；Hindsight 期望的也正是 30B（11-04 漂移记录）。
// 此前「30B 被 9B 顶掉、只能常驻 9B」的结论以 9B 抢槽为前提，pinned 后已不成立。
// 换模型时同步改这里、ci/headless-local.yml 与 ci/headless-task.sh 的默认值。
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

// 2026-11-08 用户裁决（会话 m00538：「这个新方案以后都停用本地大模型了」）：
// 默认停用本地 Lemonade 档——dispatch 不再探活 /health，也不再把「本地槽位可用」
// 当作 agent:blocked 重投的依据。DSH_LOCAL_LANE=1 只留给旧流程或本机测试临时恢复。
export const LOCAL_LANE_SWITCH = 'DSH_LOCAL_LANE';

/** 本地大模型档是否启用：默认 false，只有显式 DSH_LOCAL_LANE=1 才开。 */
export function localLaneEnabled(env = process.env) {
  return String(env?.[LOCAL_LANE_SWITCH] ?? '').toLowerCase() === '1';
}

/** 停用态的统一答复，与 poolHealth 的 { ok, why } 形状一致。 */
export function disabledLaneVerdict() {
  return {
    ok: false,
    disabled: true,
    why: '本地大模型档已停用（新方案不依赖本地模型；DSH_LOCAL_LANE=1 才启用）',
  };
}

/**
 * 重投判据（纯函数，方便单测）：任一条通道可用就重投，都不行就等下一档退避。
 * 本地档停用后只剩云端（付费档 / 免费池）一条判据。
 */
export function decideRequeue({ paid, cloud, local, localEnabled }) {
  if (paid && cloud?.ok) return { ok: true, why: `付费档可用（${cloud.why}）` };
  if (!localEnabled) {
    if (cloud?.ok) return { ok: true, why: `云端可用（${cloud?.why}）；本地大模型档已停用` };
    return { ok: false, why: `云端：${cloud?.why ?? '未知'}；本地大模型档已停用` };
  }
  if (local?.ok) return { ok: true, why: paid ? `本地槽位可用（${local.why}）` : local.why };
  return { ok: false, why: `云端：${cloud?.why ?? '未知'}；本地：${local?.why ?? '未知'}` };
}
