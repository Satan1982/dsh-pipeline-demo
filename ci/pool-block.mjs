// 免费池不可用时的处置策略。
//
// 2026-10-27 的事故：modelscope 的免费额度耗尽（insufficient balance），代码自动改走付费
// 继续跑，一夜之间在没人看的情况下把单子跑完、也把账单跑出来。用户随后定了新口径：
// **免费池全挂时不要自动烧付费，而是把工单挂起（agent:blocked）等人决定。**
//
// 所以把「判定」抽成纯函数，方便单测；网络与 GitHub 动作留在 dispatch.mjs。

// 这几类文本代表「免费池这个模型用不了」，不是「这次改动写错了」。
// 注意：要能匹配被截断过的报错，所以调用方应把原始输出尾部一起传进来。
export const FREE_POOL_PATTERNS = /QUOTA|insufficient[ _-]?balance|余额不足|无可用模型|no available model|配额|额度不足/i;

export function isFreePoolDown(text) {
  return FREE_POOL_PATTERNS.test(String(text ?? ''));
}

/**
 * 决定这一轮失败要怎么处理。
 * @param {object} o
 * @param {string} o.text       失败原因 + 原始输出尾部
 * @param {number} o.zeroTries  连续 0 token 的次数
 * @param {number} [o.zeroLimit] 连续多少次 0 token 算免费池不可用（默认 2）
 * @param {boolean} o.usePaid   本单本来就走付费（或已被人工授权付费）
 * @param {boolean} o.enabled   是否启用「挂起」策略（DSH_FREE_POOL_BLOCK=1）
 * @returns {'none'|'block'|'paid'}
 *   none  = 与免费池无关，按普通失败处理
 *   block = 免费池不可用且策略启用 → 挂起工单等人决定
 *   paid  = 免费池不可用但策略关闭（或人工已授权）→ 改走付费重试
 */
export function freePoolDecision({ text, zeroTries = 0, zeroLimit = 2, usePaid = false, enabled = true } = {}) {
  const down = isFreePoolDown(text) || Number(zeroTries) >= Number(zeroLimit);
  if (!down) return 'none';
  if (usePaid) return 'none'; // 已经花着付费的钱在跑，没有「免费池」可退了
  return enabled ? 'block' : 'paid';
}

/** 给挂起评论用的原因说明。 */
export function blockReason({ text, zeroTries = 0, zeroLimit = 2 }) {
  if (isFreePoolDown(text)) return '免费池报额度/余额不可用';
  if (Number(zeroTries) >= Number(zeroLimit)) return `连续 ${zeroTries} 次 0 token（模型没开始干活）`;
  return '免费池不可用';
}
