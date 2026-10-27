// 价目表（人民币，元 / 百万 tokens）。来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 抓取日期 2026-10-27。高峰 = 北京时间工作日 9:00-12:00 与 14:00-18:00，其余时段半价。
export const PRICES = {
  'deepseek-flash': { in: 1, out: 4, cacheHit: 0.02, peakIn: 2, peakOut: 8, peakCacheHit: 0.04 },
  'deepseek-v4-pro': { in: 4.5, out: 13.5, cacheHit: 0.15, peakIn: 9, peakOut: 27, peakCacheHit: 0.3 },
  // 免费池：登记表里 free=true 的都按 0 计（这里列常用几个，便于日志里显示 0）。
  'deepseek-ai/DeepSeek-V4.1-Flash-1017': { in: 0, out: 0, cacheHit: 0, peakIn: 0, peakOut: 0, peakCacheHit: 0 },
  'ZhipuAI/GLM-5.2': { in: 0, out: 0, cacheHit: 0, peakIn: 0, peakOut: 0, peakCacheHit: 0 },
  'Qwen/Qwen3.8-27B': { in: 0, out: 0, cacheHit: 0, peakIn: 0, peakOut: 0, peakCacheHit: 0 },
  'XingChenAGI/Xing4.0-29B': { in: 0, out: 0, cacheHit: 0, peakIn: 0, peakOut: 0, peakCacheHit: 0 },
};

// 北京时间（UTC+8）的工作日高峰判断；法定节假日不特殊处理（保守：按高峰计，宁高不低）。
export function isPeak(d = new Date()) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const h = bj.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

export function priceFor(model, d = new Date()) {
  const p = PRICES[model];
  if (!p) return null;
  const peak = isPeak(d);
  return { in: peak ? p.peakIn : p.in, out: peak ? p.peakOut : p.out, peak };
}

// 返回人民币金额（元）；模型不认识时返回 null（说明价目表该补了）。
export function costCny(usage, model, d = new Date()) {
  const p = priceFor(model, d);
  if (!p || !usage) return null;
  const inTok = Number(usage.inputTokens || 0);
  const outTok = Number(usage.outputTokens || 0);
  return (inTok * p.in + outTok * p.out) / 1e6;
}

export function formatCny(cny) {
  if (cny === null || cny === undefined) return '¥?（价目表缺该模型）';
  if (cny === 0) return '¥0';
  return `¥${cny.toFixed(cny < 0.01 ? 4 : 2)}`;
}
