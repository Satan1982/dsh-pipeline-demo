// needs-info 的回归测试（2026-11-06 P1）。
//
// 钉住三件事：
//   1. 评论必须说清「不是执行失败」、缺什么、补什么格式、怎么复活；
//   2. 邮件主题是一行、带 issue 号，正文带仓库与链接（人靠收件箱叫醒）；
//   3. 标签真的进了 REQUIRED_LABELS/LABEL_META——GitHub 对不存在的标签静默丢弃，
//      漏登记等于「打了但人看不见」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { NEEDS_INFO_LABEL, buildNeedsInfoComment, buildNeedsInfoMail } from './needs-info.mjs';
import { REQUIRED_LABELS, LABEL_META, labelPayload } from './labels.mjs';

test('评论模板：不是失败、给出验收命令格式与复活步骤', () => {
  const body = buildNeedsInfoComment({ number: 42, title: '补一行文档', reason: '无人值守拒单：缺少验收命令' });
  assert.match(body, /被挂起为 `needs-info`/);
  assert.match(body, /不是执行失败/);
  assert.match(body, /无人值守拒单：缺少验收命令/);
  assert.match(body, /### 验收命令/);
  assert.match(body, /bash scripts\/verify\.sh/);
  assert.match(body, /去掉 `needs-info`、重新打 `agent:ready`/);
  assert.match(body, /不会自动重试/);
  assert.match(body, /#42/);
});

test('评论模板：理由过长会截断，不把整段日志糊上去', () => {
  const body = buildNeedsInfoComment({ number: 1, reason: 'x'.repeat(3000) });
  assert.equal(body.includes('x'.repeat(3000)), false);
  assert.equal(body.includes('x'.repeat(1199)), true);
});

test('评论模板：缺参数不抛，仍能给出完整操作指引', () => {
  const body = buildNeedsInfoComment();
  assert.match(body, /没有给出具体原因/);
  assert.match(body, /重新打 `agent:ready`/);
});

test('邮件：主题单行带 issue 号，正文带仓库、原因、链接', () => {
  const { subject, body } = buildNeedsInfoMail({
    number: 42,
    title: '补\n一行文档',
    reason: '无人值守拒单：缺少验收命令',
    repo: 'Satan1982/dsh-pipeline-demo',
  });
  assert.equal(subject, '[needs-info] #42 补 一行文档');
  assert.equal(subject.includes('\n'), false);
  assert.match(body, /Satan1982\/dsh-pipeline-demo/);
  assert.match(body, /#42/);
  assert.match(body, /缺少验收命令/);
  assert.match(body, /https:\/\/github\.com\/Satan1982\/dsh-pipeline-demo\/issues\/42/);
});

test('邮件：无仓库/无链接时不编造地址', () => {
  const { body } = buildNeedsInfoMail({ number: 7, title: 't', reason: 'r' });
  assert.equal(body.includes('https://github.com//issues/7'), false);
  assert.match(body, /仓库：\(未配置\)/);
});

test('标签已登记：清单里有，元数据颜色/说明齐全', () => {
  assert.equal(NEEDS_INFO_LABEL, 'needs-info');
  assert.equal(REQUIRED_LABELS.includes(NEEDS_INFO_LABEL), true);
  const payload = labelPayload(NEEDS_INFO_LABEL);
  assert.equal(payload.name, 'needs-info');
  assert.match(payload.color, /^[0-9a-f]{6}$/);
  assert.ok(payload.description && payload.description.length > 0);
  assert.equal(LABEL_META[NEEDS_INFO_LABEL].color, payload.color);
});
