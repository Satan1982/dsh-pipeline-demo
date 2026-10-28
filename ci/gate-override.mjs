#!/usr/bin/env node
/**
 * gate-override.mjs — 「放行修改门禁脚本」这件事的留痕层。
 *
 * 为什么需要（2026-10-28 架构评审 P0-2）：
 * 设计原则是「门禁是裁判，不能被选手改」。但本地提交这条路上，判据只有
 * `DSH_ALLOW_GATE=1` 一个环境变量——agent 自己 export 一下就能放行，
 * 事后没人分得清「用户授权」和「选手自己吹哨」。自动化路径（走 issue 的
 * `allow:gate` 标签）是有机械校验的，本地提交没有。
 *
 * 这里补的不是拦截（拦截会挡住合法的紧急修改），而是**可审计**：
 *   ① 放行必须带理由（DSH_ALLOW_GATE_REASON），空理由直接拒；
 *   ② 每次放行写一行 gate-override.jsonl（时间/文件/理由/仓库/HEAD）。
 * 判据都是纯函数，单测不需要真的提交。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const OVERRIDE_ENV = 'DSH_ALLOW_GATE';
export const REASON_ENV = 'DSH_ALLOW_GATE_REASON';

export function overrideLogFile(home = homedir()) {
  return process.env.DSH_GATE_OVERRIDE_LOG || path.join(home, '.dsh', 'coord', 'log', 'gate-override.jsonl');
}

/** 环境变量 → { on, ok, reason } / { on:true, ok:false, error }。没开就 on:false。 */
export function overrideDecision(env = process.env) {
  const on = String(env[OVERRIDE_ENV] ?? '').trim() === '1';
  if (!on) return { on: false, ok: false };
  const reason = String(env[REASON_ENV] ?? '').trim();
  if (!reason) {
    return {
      on: true,
      ok: false,
      error: `设了 ${OVERRIDE_ENV}=1 但没写 ${REASON_ENV}：放行修改门禁必须说明理由（会记进 gate-override.jsonl）`,
    };
  }
  return { on: true, ok: true, reason };
}

/** 评审结果里「被放行的门禁改动」涉及哪些文件（去重，保持顺序）。 */
export function gateFilesFromFindings(findings = []) {
  const out = [];
  for (const f of findings) {
    if (f?.rule !== 'gate-modified') continue;
    if (f?.file && !out.includes(f.file)) out.push(f.file);
  }
  return out;
}

export function overrideRecord({ reason, files = [], at = new Date().toISOString(), repo = '', head = '' } = {}) {
  return { at, kind: 'gate-override', reason: String(reason ?? '').trim(), files: [...files], repo, head };
}

/** 追加一行；返回写入的文件路径。失败由调用方决定要不要拦（默认不拦提交）。 */
export function appendOverride(rec, file = overrideLogFile()) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
  return file;
}
