// ci/pass3/describe-exit.mjs — 把 Pass^3 run.mjs 的退出码翻成稳定短句。
//
// 为什么单独一个文件：退出码是调度器唯一能无条件相信的信号
// （docs/research/top-repos.md:17），但 2/3/4/5/6 对人不直观。
// 统一翻成同一套词，日志、PR 备注和失败指纹才不会各写各的。
// 未知码一律 'unknown'，不临时拼 `exit-${code}`——那会让指纹随环境漂移。

const EXIT_CODES = Object.freeze({
  0: 'ok',
  2: 'invalid-spec',
  3: 'verify-failed',
  4: 'worker-failed',
  5: 'timeout',
  6: 'rejected',
});

/**
 * @param {number} code run.mjs 的退出码
 * @returns {'ok'|'invalid-spec'|'verify-failed'|'worker-failed'|'timeout'|'rejected'|'unknown'}
 */
export function describeExit(code) {
  return Object.prototype.hasOwnProperty.call(EXIT_CODES, code)
    ? EXIT_CODES[code]
    : 'unknown';
}
