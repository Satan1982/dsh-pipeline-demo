import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EVENT_KINDS, MAX_MESSAGE, eventRecord, formatEventLine, toastText,
  psToastBody, writeToastScript, appendEvent, webhookBody, postWebhook,
} from '../ci/notify.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'notify-'));

test('事件记录：只留机器字段，长原因截断到 300', () => {
  const rec = eventRecord({ kind: 'failed', issue: 88, why: 'x'.repeat(400), at: '2026-10-28T00:00:00.000Z' });
  assert.deepEqual(Object.keys(rec), ['at', 'kind', 'issue', 'why']);
  assert.equal(rec.kind, 'failed');
  assert.equal(rec.issue, 88);
  assert.equal(rec.why.length, 300);
  assert.ok(rec.why.endsWith('…'));
  assert.equal(eventRecord({ kind: 'daycap', cny: 5 }).cny, 5);
  assert.equal(eventRecord({ kind: 'x' }).issue, undefined);
});

test('一行一条 JSON，能被 reparse', () => {
  const line = formatEventLine(eventRecord({ kind: 'blocked-manual', issue: 7, why: '重投 3 次仍未过' }));
  assert.ok(!line.includes('\n'));
  const back = JSON.parse(line);
  assert.equal(back.issue, 7);
  assert.equal(back.kind, 'blocked-manual');
});

test('弹窗文案：标题带单号与中文事件名', () => {
  assert.deepEqual(toastText({ kind: 'failed', issue: 88, why: 'boom' }), { title: '流水线 #88 任务失败', message: 'boom' });
  assert.equal(toastText({ kind: 'daycap', why: '今日已花 ¥5' }).title, '流水线 今日花费到顶');
  assert.equal(toastText({ kind: 'weird' }).title, '流水线 weird');
  assert.equal(toastText({ kind: 'failed', why: 'y'.repeat(500) }).message.length, MAX_MESSAGE);
});

test('Toast 脚本：XML 文本节点里的五个字符被转义', () => {
  const body = psToastBody({ title: 'A & B <c>', message: 'it\'s "ok"' });
  assert.ok(body.includes('A &amp; B &lt;c&gt;'));
  assert.ok(body.includes('it&apos;s &quot;ok&quot;'));
  assert.ok(body.includes('CreateToastNotifier'));
  assert.ok(!body.includes('<c>'));
});

test('写 .ps1：带 UTF-8 BOM（PS 5.1 没 BOM 会按 GBK 解，中文全乱）', () => {
  const dir = tmp();
  try {
    const file = writeToastScript(path.join(dir, 'sub', 'toast.ps1'), { title: '流水线 #1 任务失败', message: '原因' });
    const raw = readFileSync(file, 'utf8');
    assert.equal(raw.charCodeAt(0), 0xFEFF);
    assert.ok(raw.includes('流水线 #1 任务失败'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('appendEvent：建目录 + 追加而不是覆盖', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'log', 'events.jsonl');
    appendEvent(file, eventRecord({ kind: 'failed', issue: 1 }));
    appendEvent(file, eventRecord({ kind: 'failed', issue: 2 }));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).issue, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('EVENT_KINDS 覆盖所有需要人知道的事件', () => {
  // 2026-10-28 架构评审后扩了四类：评审缺失/降级、状态不一致、门禁被放行修改。
  assert.deepEqual(Object.keys(EVENT_KINDS).sort(), [
    'blocked-manual', 'daycap', 'failed', 'gate-override', 'review-degraded', 'review-missing', 'state-drift',
  ]);
});

test('webhook 正文：标题带工单号，没有工单号时不带 #', () => {
  const body = webhookBody({ kind: 'failed', issue: 88, why: '验收命令 exit 1', at: '2026-10-28T00:00:00.000Z' });
  assert.match(body.text, /\[流水线 #88\] 任务失败/);
  assert.match(body.text, /验收命令 exit 1/);
  assert.equal(body.kind, 'failed');
  assert.equal(body.at, '2026-10-28T00:00:00.000Z');
  assert.doesNotMatch(webhookBody({ kind: 'daycap', why: '到顶' }).text, /#/);
});

test('webhook 未配置时直接跳过，不发请求', async () => {
  let called = 0;
  const r = await postWebhook('', { kind: 'failed', why: 'x' }, { fetchImpl: () => { called += 1; } });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, 'no-webhook');
  assert.equal(called, 0);
});

test('webhook 成功投递：POST JSON 到给定 URL', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => { seen.push({ url, init }); return { ok: true, status: 204 }; };
  const r = await postWebhook('https://example.test/hook', { kind: 'failed', issue: 7, why: 'x' }, { fetchImpl: fakeFetch });
  assert.equal(r.ok, true);
  assert.equal(r.status, 204);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://example.test/hook');
  assert.equal(seen[0].init.method, 'POST');
  assert.match(seen[0].init.headers['content-type'], /json/);
  assert.equal(JSON.parse(seen[0].init.body).issue, 7);
});

test('webhook 失败不抛异常：返回错误原因（调用方只记一行日志）', async () => {
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  const r = await postWebhook('https://example.test/hook', { kind: 'failed', why: 'x' }, { fetchImpl: boom });
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});
