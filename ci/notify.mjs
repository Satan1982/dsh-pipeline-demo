#!/usr/bin/env node
// 「需要人知道」的事件落到两个地方：
//   ① events.jsonl（机器可读，daily digest 每天读它出摘要）；
//   ② Windows 通知（人可读，只在真的值得打断时弹）。
//
// 通知是 best-effort：发不出去只记一行，绝不让调度器因为「弹窗失败」停摆。
// 为什么把 PowerShell 写成文件再跑：PS 5.1 按 GBK 解码命令行参数，中文标题从 -Command
// 传进去一定是乱码（P26）；写成 UTF-8 带 BOM 的 .ps1 再 -File 跑才对（P1）。
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const EVENT_KINDS = {
  failed: '任务失败',
  'blocked-manual': '需要人工接手',
  daycap: '今日花费到顶',
  'review-missing': '语义评审缺失',
  'review-degraded': '语义评审降级',
  'state-drift': '状态不一致',
  'gate-override': '门禁被放行修改',
};

export const MAX_TITLE = 60;
export const MAX_MESSAGE = 200;
const MAX_WHY = 300;

function clip(s, n) {
  const t = String(s ?? '');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

// 事件记录：只放机器要用的字段，别把整段日志塞进来（digest 每天都要读）。
export function eventRecord({ kind, issue, why, at, cny } = {}) {
  const rec = { at: at ?? new Date().toISOString(), kind: String(kind ?? 'unknown') };
  if (issue !== undefined && issue !== null && Number.isFinite(Number(issue))) rec.issue = Number(issue);
  if (why) rec.why = clip(why, MAX_WHY);
  if (cny !== undefined && cny !== null && Number.isFinite(Number(cny))) rec.cny = Number(cny);
  return rec;
}

export function formatEventLine(rec) {
  return JSON.stringify(rec);
}

// 弹窗文案：标题说清「哪张单、什么事」，正文说原因。太长就截断——Toast 显示不下也没用。
export const AUMID = 'DSH Pipeline';

// Windows 只在 AppUserModelId 已注册时才真的弹 toast；没注册时 CreateToastNotifier
// 不报错、脚本 exit 0，通知被静默丢弃（08:05 实测：HKCU 下两个键都不存在）。
// 送达证据 = Notifications\Settings\<AUMID>：系统真弹过一次才会建它。
export function aumidKey(aumid = AUMID) {
  return `HKCU\\Software\\Classes\\AppUserModelId\\${aumid}`;
}
export function settingsKey(aumid = AUMID) {
  return `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${aumid}`;
}
export function regQueryArgs(aumid = AUMID) {
  return ['query', aumidKey(aumid)];
}
export function regAddArgs(aumid = AUMID) {
  return ['add', aumidKey(aumid), '/v', 'DisplayName', '/t', 'REG_SZ', '/d', aumid, '/f'];
}

export function toastText({ kind, issue, why } = {}) {
  const name = EVENT_KINDS[kind] ?? String(kind ?? '事件');
  const head = issue !== undefined && issue !== null ? `流水线 #${issue} ${name}` : `流水线 ${name}`;
  return { title: clip(head, MAX_TITLE), message: clip(why, MAX_MESSAGE) };
}

// XML 文本节点里必须转义的五个字符：标题带 & 或 < 会让 LoadXml 直接抛异常。
function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function psToastBody({ title, message }) {
  const xml = `<toast><visual><binding template='ToastGeneric'><text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text></binding></visual></toast>`;
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml("${xml}")`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("DSH Pipeline").Show($toast)',
  ].join('; ');
}

// 写一个 UTF-8 **带 BOM** 的 .ps1：PS 5.1 见不到 BOM 就按 GBK 解，中文全乱（P1）。
export function writeToastScript(file, { title, message }) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, `\uFEFF${psToastBody({ title, message })}\n`, 'utf8');
  return file;
}

export function appendEvent(file, rec) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, `${formatEventLine(rec)}\n`, 'utf8');
  return file;
}

// ── 远端出口（webhook）───────────────────────────────────────────────────────
// 为什么要有：Toast 只在本机弹。人不在机器前（或者机器是无人值守的）时，
// `failed` / `blocked-manual` 这类必须打断人的事件等于没人收到（2026-10-28 架构评审 P0-3）。
// 默认不开：没配 DSH_NOTIFY_WEBHOOK 就整段跳过，行为与以前完全一致。
// 同样是 best-effort：POST 失败只记一行，绝不影响调度器。
export function webhookBody(rec) {
  const name = EVENT_KINDS[rec?.kind] ?? String(rec?.kind ?? '事件');
  const head = rec?.issue ? `[流水线 #${rec.issue}] ${name}` : `[流水线] ${name}`;
  // issue 单列一个字段：接收端（飞书/钉钉/自建）经常要按工单路由，不该让它去解析文本。
  return { text: `${head}\n${rec?.why ?? ''}`.trim(), kind: rec?.kind ?? 'unknown', issue: rec?.issue ?? null, at: rec?.at ?? new Date().toISOString() };
}

export async function postWebhook(url, rec, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!url) return { ok: false, skipped: 'no-webhook' };
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'no-fetch-available' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(500, Number(timeoutMs) || 5000));
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookBody(rec)),
      signal: ac.signal,
    });
    return { ok: Boolean(res?.ok), status: res?.status ?? null };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}
