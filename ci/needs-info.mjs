// needs-info：无人值守「缺东西、没法开工」时的异步问答出口（2026-11-06 P1）。
//
// 与 agent:failed 的区别：
//   agent:failed = 跑过了但失败（重试预算耗完 / 代码或门禁红了）→ 人修完重打 ready 重试；
//   needs-info   = 根本没跑：缺 `### 验收命令`、命令不可判负、缺目标/验收标准、信息不足。
// 两者都摘 `agent:ready`、都靠人重打 `agent:ready` 复活，但 needs-info 不耗重试预算、
// 不发「任务失败」告警，而且会发一封邮件——人不在时，唯一能叫醒人的是收件箱。

export const NEEDS_INFO_LABEL = 'needs-info';

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\r\n/g, '\n').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

/**
 * issue 上的中文评论：说清楚「不是执行失败」、缺什么、补什么格式、怎么复活。
 * 模板里的 `### 验收命令` 用 ~~~ 围起来，避免 GitHub 把它渲染成标题。
 */
export function buildNeedsInfoComment({ number, title, reason } = {}) {
  const why = clip(reason, 1200) || '（调度器没有给出具体原因）';
  return [
    `⏸️ 这张单被挂起为 \`${NEEDS_INFO_LABEL}\`：**不是执行失败**，是缺东西、没法开工（没有消耗重试预算）。`,
    '',
    '原因：',
    '```',
    why,
    '```',
    '',
    '**请改 issue 正文补齐**（不用新开单）：',
    '',
    '~~~markdown',
    '### 验收命令',
    'bash scripts/verify.sh',
    '~~~',
    '',
    '- 至少一行**能真失败**的命令；`echo ok`、`true`、`|| true`、管道到 `tail`/`head`、以及 `acceptance:optional` 标签都不会被接受。',
    '- 缺目标/验收标准时，一并补齐 `### 目标` 与 `### 验收标准（可执行）`。',
    '',
    '**回复后怎么复活**：去掉 `needs-info`、重新打 `agent:ready`。调度器不会自动重试，也不会因为超时自动判死。',
    '',
    `> 自动消息 · issue #${number ?? '?'}${title ? ` ${clip(title, 60)}` : ''}`,
  ].join('\n');
}

/** 邮件正文：把「哪个仓、哪张单、为什么、怎么继续」四件事说全，尽量短。 */
export function buildNeedsInfoMail({ number, title, reason, repo } = {}) {
  const subject = `[needs-info] #${number ?? '?'} ${clip(title, 60) || '(无标题)'}`.replace(/\s+/g, ' ').trim();
  const body = [
    `仓库：${repo || '(未配置)'}`,
    `Issue：#${number ?? '?'} ${clip(title, 120)}`,
    '',
    `原因：${clip(reason, 1500)}`,
    '',
    '怎么继续：改 issue 正文补 `### 验收命令`（能真失败的命令），然后去掉 `needs-info`、重新打 `agent:ready`。',
    repo && number ? `链接：https://github.com/${repo}/issues/${number}` : '',
  ]
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n');
  return { subject, body };
}
