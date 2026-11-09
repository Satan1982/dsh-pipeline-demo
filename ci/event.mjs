#!/usr/bin/env node
// 无人值守停机时「让人第二天知道」的 CLI。
//
// 为什么不是直接调 notify.mjs：它是纯函数库（appendEvent 无 try），也不是 CLI；
// 协议里写「写 ALERT + appendEvent」全靠人照着做。这里把顺序固定死：
//   ① 先写 ALERT 文件（原子 rename）——它是人回来看的唯一入口，必须最先落盘；
//   ② 再 appendEvent（全 try/catch）——落盘失败只记 errors，不改停机码；
//   ③ 最后 best-effort 弹窗——本机静默丢弃也不影响前两步。
// 退出码：0 = ALERT（或未指定 alert 目录时的 event）已写成；1 = 关键产物没写成；2 = 用法错。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendEvent, eventRecord, regAddArgs, regQueryArgs, settingsKey, toastText, writeToastScript,
} from './notify.mjs';

export const ALERT_PREFIX = 'ALERT-';

export function defaultEventsFile() {
  return process.env.DSH_EVENTS_LOG || path.join(homedir(), '.dsh', 'coord', 'log', 'events.jsonl');
}

function stamp(at) {
  return String(at).replace(/[:.]/g, '-');
}

export function alertMarkdown(rec) {
  return [
    `# 无人值守停机 · ${rec.kind}`,
    '',
    `- 时间：${rec.at}`,
    ...(rec.issue ? [`- 工单：#${rec.issue}`] : []),
    `- 原因：${rec.why ?? '（未写）'}`,
    '',
    '人回来先看这里，再看 `~/.dsh/coord/log/events.jsonl` 与 `.logs/dispatch.log`。',
    '处理完后去掉 `agent:failed`、重新加 `agent:ready` 才会重试。',
    '',
  ].join('\n');
}

// 原子写：先写 .tmp 再 rename，避免人正好在写一半时读到半截。
export function writeAlert(dir, rec) {
  const name = `${ALERT_PREFIX}${stamp(rec.at)}.md`;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, alertMarkdown(rec), 'utf8');
  renameSync(tmp, file);
  return file;
}

function ensureAumid() {
  if (spawnSync('reg', regQueryArgs(), { timeout: 5000, stdio: 'ignore', windowsHide: true }).status === 0) return true;
  return spawnSync('reg', regAddArgs(), { timeout: 5000, stdio: 'ignore', windowsHide: true }).status === 0;
}

export function sendToast(rec, { dir = path.join(homedir(), '.dsh', 'coord', 'log') } = {}) {
  try {
    const { title, message } = toastText(rec);
    mkdirSync(dir, { recursive: true });
    const script = writeToastScript(path.join(dir, 'notify-toast.ps1'), { title, message });
    const aumid = ensureAumid();
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      timeout: 15000, stdio: 'ignore', windowsHide: true,
    });
    const seen = spawnSync('reg', ['query', settingsKey()], { timeout: 5000, stdio: 'ignore', windowsHide: true });
    return { ok: r.status === 0, aumid, delivered: seen.status === 0 };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// 默认不弹窗：CLI 只在显式没给 --no-toast 时弹；测试直接调 recordEvent 不弹。
export function recordEvent({
  kind = 'failed', why, issue, cny, at, eventsFile, alertDir, toast = false,
  toastImpl = sendToast,
} = {}) {
  const rec = eventRecord({ kind, issue, why, at, cny });
  const errors = [];
  let alert = null;
  let event = null;
  if (alertDir) {
    try {
      alert = writeAlert(alertDir, rec);
    } catch (e) {
      errors.push(`写 ALERT 失败：${e.message}`);
    }
  }
  try {
    event = appendEvent(eventsFile || defaultEventsFile(), rec);
  } catch (e) {
    errors.push(`写事件失败：${e.message}`);
  }
  let toastResult = null;
  if (toast) {
    toastResult = toastImpl(rec);
    if (!toastResult?.ok) errors.push(`弹窗失败：${toastResult?.error ?? '未知'}`);
  }
  const ok = alertDir ? Boolean(alert) : Boolean(event);
  return { ok, alert, event, toast: toastResult, errors };
}

const USAGE = '用法：node ci/event.mjs --why "停机原因" [--kind failed] [--issue N] [--cny 1.2] [--alert-dir DIR] [--events FILE] [--no-toast]';

export function parseArgs(argv) {
  const opt = { kind: 'failed', toast: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--why') opt.why = argv[++i];
    else if (a === '--kind') opt.kind = argv[++i];
    else if (a === '--issue') opt.issue = Number(argv[++i]);
    else if (a === '--cny') opt.cny = Number(argv[++i]);
    else if (a === '--alert-dir') opt.alertDir = argv[++i];
    else if (a === '--events') opt.eventsFile = argv[++i];
    else if (a === '--no-toast') opt.toast = false;
    else if (a === '--help' || a === '-h') opt.help = true;
    else return { error: `未知参数：${a}` };
  }
  return { opt };
}

export function runCli(argv, { out = console.log, err = console.error } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    err(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const { opt } = parsed;
  if (opt.help) {
    out(USAGE);
    return 0;
  }
  if (!opt.why) {
    err(`缺少 --why（停机原因就是给人看的全部信息）\n${USAGE}`);
    return 2;
  }
  const r = recordEvent(opt);
  for (const e of r.errors) err(`[event] ${e}`);
  out(r.alert ? `ALERT 已写：${r.alert}` : `事件已写：${r.event ?? '无'}`);
  if (r.toast?.ok) out(`通知：${r.toast.delivered ? '已确认送达' : '已发但未确认送达'}`);
  return r.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = runCli(process.argv.slice(2));
}
