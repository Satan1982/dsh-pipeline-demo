// v3 P2（docs/89 §3.5）：Pass^3 度量与失败归因。
//
// 度量纪律（docs/89 line 77）：
//   - 一个「任务」的成功 = 同一任务在独立环境里跑 3 次、3 次全过（Pass^3）。
//   - n ≥ 36 才能下「达到 0.7」的结论；n < 36 只报原始比例 + Wilson 95% 区间。
//   - 先报 n，再报比例：小样本的高比例（3/3 = 100%）没有任何统计意义。
//
// first_error（docs/89 line 79）：门禁失败时把「第一个失败的测试」钉出来，
// 而不是让人从几十行输出尾部里猜根因。这里只做解析，不执行任何命令。

export const PASS3_MIN_N = 36;
export const PASS3_TARGET = 0.7;
export const PASS3_RUNS = 3;

// Wilson 95% 区间（不用正态近似：小样本、比例接近 0/1 时正态区间会越界且失真）。
export function wilsonInterval(successes, total, z = 1.96) {
  const k = Number(successes);
  const n = Number(total);
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) {
    throw new RangeError(`wilsonInterval 需要 0 <= successes <= total，且 total > 0（收到 ${successes}/${total}）`);
  }
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    successes: k,
    total: n,
    p,
    low: Math.max(0, center - half),
    high: Math.min(1, center + half),
  };
}

export function formatInterval({ low, high }) {
  return `[${(low * 100).toFixed(1)}%, ${(high * 100).toFixed(1)}%]`;
}

// tasks: [{ id, runs: [true, false, true] }]
// Pass^3 只认「正好跑满 3 次且全过」；不足 3 次的样本按未通过计入比例，
// 并在 incomplete 里单独列出——不许把「少跑了」静默算成通过。
export function summarizePass3(tasks, { minN = PASS3_MIN_N, target = PASS3_TARGET, runs = PASS3_RUNS } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new TypeError('summarizePass3 需要非空的 tasks 数组');
  }
  const rows = [];
  for (const task of tasks) {
    const record = Array.isArray(task.runs) ? task.runs : [];
    const complete = record.length >= runs;
    const passed = complete && record.slice(0, runs).every((ok) => ok === true);
    rows.push({ id: task.id, runs: record, complete, passed });
  }
  const n = rows.length;
  const pass3 = rows.filter((r) => r.passed).length;
  const interval = wilsonInterval(pass3, n);
  const incomplete = rows.filter((r) => !r.complete).map((r) => r.id);
  const canClaim = n >= minN;
  const ratio = pass3 / n;
  const meetsTarget = ratio >= target;
  const verdict = canClaim
    ? `Pass^3 = ${(ratio * 100).toFixed(1)}%（${pass3}/${n}，Wilson 95% ${formatInterval(interval)}）；n=${n} ≥ ${minN}，可对照目标 ${target}：${meetsTarget ? '达标' : '未达标'}`
    : `n=${n} < ${minN}：只报原始比例 ${(ratio * 100).toFixed(1)}%（Pass^3 ${pass3}/${n}，Wilson 95% ${formatInterval(interval)}），不得宣称达到 ${target}`;
  return { n, pass3, ratio, interval, canClaim, meetsTarget, incomplete, rows, verdict };
}

// ---- first_error ----
//
// 支持两种输出：TAP（`not ok 1 - name`）与 spec（`✖ failing tests:` + `✖ name`）。
// 只认「测试失败」；解析不到就 found=false，调用方不许拿空结果当「第一个测试通过」。

export function parseFirstError(output) {
  const text = String(output ?? '');
  if (!text.trim()) return { found: false };
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*not ok\s+\d+\s+-\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    const test = m[1].replace(/\s*#\s*(SKIP|TODO)\s*/i, '').trim();
    return {
      found: true,
      kind: 'tap',
      test,
      file: null,
      line: null,
      excerpt: lines.slice(i, i + 6).join('\n'),
    };
  }

  const failingIndex = lines.findIndex((line) => line.includes('✖ failing tests:'));
  if (failingIndex >= 0) {
    for (let i = failingIndex + 1; i < lines.length; i += 1) {
      const m = /^\s*✖\s+(.*)$/.exec(lines[i]);
      if (!m) continue;
      const test = m[1].replace(/\s*\(.*?ms\)\s*$/, '').trim();
      const loc = lines.slice(i, i + 4).join('\n').match(/test at\s+(\S+):(\d+):(\d+)/);
      return {
        found: true,
        kind: 'spec',
        test,
        file: loc ? loc[1] : null,
        line: loc ? Number(loc[2]) : null,
        excerpt: lines.slice(i, i + 8).join('\n'),
      };
    }
  }

  // 兜底：只给出错误类型，不编造测试名。
  const errLine = lines.find((line) => /AssertionError|RangeError|TypeError|Error:/.test(line));
  if (errLine) return { found: true, kind: 'error', test: null, file: null, line: null, excerpt: errLine.trim() };
  return { found: false };
}

export function formatFirstError(parsed) {
  if (!parsed || !parsed.found) return '（未解析到失败测试）';
  const where = parsed.file ? ` @ ${parsed.file}${parsed.line ? `:${parsed.line}` : ''}` : '';
  return `${parsed.test ?? parsed.excerpt ?? '未知失败'}${where}`;
}
