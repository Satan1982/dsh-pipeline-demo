// rebase 冲突分类。
//
// 每个 agent PR 都要改 scripts/test-baseline.txt（测试数与断言数）和
// scripts/assert-baseline.txt（每条断言一行），所以并行 PR 十有八九正好
// 在这两个文件上冲突。这类冲突是可重算的：合并之后的测试文件才是事实，
// 基线应该由 `bash scripts/verify.sh --bless` 重新算出来，而不是让人去
// 挑「要 82 还是 84」。其余任何文件冲突仍然必须转人工。
const BASELINE_FILE = /^scripts\/(test|assert)-baseline\.txt$/;

export function classifyConflicts(files) {
  const list = (files ?? []).map((f) => String(f).trim()).filter(Boolean);
  if (list.length === 0) return { kind: 'none', files: [] };
  const baselineOnly = list.every((f) => BASELINE_FILE.test(f));
  return { kind: baselineOnly ? 'baseline-only' : 'manual', files: list };
}

export const BASELINE_FILE_RE = BASELINE_FILE;
