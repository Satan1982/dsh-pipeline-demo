// 调度器需要的仓库标签清单。
//
// 为什么单独拿出来：GitHub 给 issue 打一个**不存在的标签**不会报错，它静默丢弃。
// 2026-10-28 实测过：仓库里没有 agent:blocked:manual，giveup 分支打上去看起来成功，
// 实际上 issue 上什么也没多——人从标签上完全看不出「这张单要人工接手」。
//
// 所以调度器启动时先补齐一次（网络动作在 dispatch.mjs，这里只放清单与判据，便于单测）。
// dep-on:<任务号> 不在清单里：它是人随手加的，名字取决于任务号，代码无从枚举。

/** 代码里会打的、必须在仓库里存在的标签（顺序即日志里的展示顺序）。 */
export const REQUIRED_LABELS = [
  'agent:ready',
  'agent:working',
  'agent:done',
  'agent:failed',
  'agent:blocked',
  'agent:blocked:manual',
  'model:strong',
  'model:paid',
  'model:free',
  'allow:gate',
  'readonly:ok',
  'merge:auto',
  'acceptance:optional',
  'verdict:strict',
];

/**
 * 新建标签时用的颜色与说明。颜色是 GitHub 的 6 位 hex（不带 #）。
 * 只影响观感，写错也只是难看，不影响打标签。
 */
export const LABEL_META = {
  'agent:ready': { color: '0e8a16', description: '待领取，调度器会拿它跑' },
  'agent:working': { color: '1d76db', description: '正在跑（调度器持有）' },
  'agent:done': { color: '5319e7', description: '已完成并合并/交付' },
  'agent:failed': { color: 'b60205', description: '失败，需要人或下一次重试' },
  'agent:blocked': { color: 'd93f0b', description: '挂起：环境不满足，不该继续跑' },
  'agent:blocked:manual': { color: '8b1a1a', description: '自动恢复放弃了，等人接手' },
  'model:strong': { color: '006b75', description: '强制用强模型档' },
  'model:paid': { color: 'e4e669', description: '允许花付费额度' },
  'model:free': { color: 'c2e0c6', description: '只用免费池' },
  'allow:gate': { color: 'fbca04', description: '允许本次改动触及门禁文件' },
  'readonly:ok': { color: 'c5def5', description: '允许只读改动' },
  'merge:auto': { color: '2cbe4e', description: 'CI 绿了自动 squash 合并' },
  'acceptance:optional': { color: 'd4c5f9', description: '没有验收命令也放行' },
  'verdict:strict': { color: 'ededed', description: '缺 VERDICT 行即失败' },
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * 差集：required 里哪些在 existing 里没有（existing 可以是字符串数组，也可以是 GitHub 返回的
 * `{name}` 对象数组）。按 required 的顺序返回，比较时忽略大小写与首尾空格。
 * @param {Array<string|{name?:string}>} existing
 * @param {string[]} [required]
 * @returns {string[]}
 */
export function missingLabels(existing, required = REQUIRED_LABELS) {
  const have = new Set((Array.isArray(existing) ? existing : []).map((l) => norm(l && typeof l === 'object' ? l.name : l)).filter(Boolean));
  return required.filter((name) => !have.has(norm(name)));
}

/** 建标签的请求体：name 必填，color/description 有就给。 */
export function labelPayload(name, meta = LABEL_META) {
  const m = meta[name] ?? {};
  const body = { name: String(name) };
  if (m.color) body.color = m.color;
  if (m.description) body.description = m.description;
  return body;
}

/** 日志里列标签：`a、b、c 等 5 个`，避免一次打 14 个名字糊满一行。 */
export function formatLabelList(names, limit = 6) {
  const list = (Array.isArray(names) ? names : []).map(String);
  if (!list.length) return '（无）';
  if (list.length <= limit) return list.join('、');
  return `${list.slice(0, limit).join('、')} 等 ${list.length} 个`;
}
