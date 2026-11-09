#!/usr/bin/env node
// ci/gate-log.mjs —— 门禁输出落盘（P6「日志落盘」）。
//
// 为什么（docs/88 门禁对照表 #8）：dispatch 只把 `gate_bytes_sha256` 签进 witness，
// 成功门禁的完整 stdout 之前不落盘 —— 事后问「这次门禁到底跑了哪些用例」只能翻
// .logs/issue-N-attempt-M.log（那是 agent 的输出，不是门禁的），或者重跑一遍。
// run.mjs 的 P6 一直写 verify.log，生产链缺这一份，补上。
//
// 落盘失败不判任务失败：日志是证据，不是交付物（同 verifyWorktree 里候选树清理的口径）。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NL = String.fromCharCode(10);

export function gateLogName(issue, attempt) {
  return `gate-issue-${issue}-attempt-${attempt}.log`;
}

export function writeGateLog(logDir, { issue, attempt, code, stdout, sha } = {}) {
  try {
    mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, gateLogName(issue, attempt));
    const body = String(stdout ?? '').trim() || '（门禁没有任何输出）';
    const text = [`exit=${code ?? -1}`, `gate_bytes_sha256=${sha || '(none)'}`, '===== stdout =====', body, ''].join(NL);
    writeFileSync(file, text);
    return { ok: true, file, bytes: Buffer.byteLength(text) };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}
