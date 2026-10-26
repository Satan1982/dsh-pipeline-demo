// usage.mjs — 从 `dsh --profile headless --json` 的事件流里取 token 用量。
//
// 为什么要自己做：headless profile 没有装 cost-meter 插件，账本里看不到这些 run
// （账本只记录装了这个插件的 profile 的会话）。而 `--json` 模式会把每一步的
// `{"type":"status","phase":"step_end","usage":{"inputTokens":…,"outputTokens":…}}`
// 打到 stdout，所以调度器自己累加即可。

export function sumUsage(ndjson) {
  let inputTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  for (const line of String(ndjson ?? '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(s);
    } catch {
      continue;
    }
    const usage = event && event.usage;
    if (!usage || typeof usage !== 'object') continue;
    const inTok = Number(usage.inputTokens);
    const outTok = Number(usage.outputTokens);
    if (!Number.isFinite(inTok) && !Number.isFinite(outTok)) continue;
    inputTokens += Number.isFinite(inTok) ? inTok : 0;
    outputTokens += Number.isFinite(outTok) ? outTok : 0;
    steps += 1;
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, steps };
}

export function formatUsage(usage) {
  if (!usage || !usage.steps) return '统计不到（headless 没有回报 usage）';
  return `${usage.totalTokens} tokens（in ${usage.inputTokens} / out ${usage.outputTokens}，${usage.steps} 步）`;
}

// `--json` 模式下 stdout 是事件流，人要看的最终回答在 `final` 事件里。
// 取不到就退回把 text 事件拼起来，再不行保留原始输出（排障用）。
export function finalText(ndjson) {
  const lines = String(ndjson ?? '').split('\n');
  let final = null;
  const texts = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(s);
    } catch {
      continue;
    }
    if (event.type === 'final') {
      final = typeof event.text === 'string' ? event.text : typeof event.message === 'string' ? event.message : null;
    } else if (event.type === 'text' && typeof event.text === 'string') {
      texts.push(event.text);
    }
  }
  if (final !== null) return final;
  if (texts.length) return texts.join('');
  return String(ndjson ?? '');
}
