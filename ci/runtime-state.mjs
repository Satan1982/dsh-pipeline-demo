// 运行态（暂停 / 只读体检 / 恢复）：终稿裁决的三件小工具，共约 80 行。
//
// 为什么必须有：旧版只有一个内存变量 `PAUSE_CLAIM`（`ci/dispatch.mjs` 的 `PAUSE_CLAIM`），进程一重启就清零——
// 日闸在 18:00 熔断、19:00 计划任务把常驻进程重拉一次，它就又满血开始领新单了。
// 而且 `--status` 根本不存在：`ci/dispatch.mjs` 只认 6 个旗标，未知旗标会直接掉进
// `while (true)` 变成常驻进程——想「看一眼」反而起了个调度器，这是最危险的一种误操作。
//
// 这里只放纯函数，不碰网络、不碰锁；CLI 入口在 `ci/dispatch.mjs` 的 `runtimeCommand()`。
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STATE_NAME = 'state.json';

// 暂停态落盘在 .logs/state.json，与 dispatch.lock 同目录：锁回答「谁在跑」，它回答「能不能领新单」。
export function stateFile(logDir) {
  return path.join(logDir, STATE_NAME);
}

export function readState(logDir) {
  const f = stateFile(logDir);
  if (!existsSync(f)) return { paused: false, pausedAt: null, pausedWhy: null, updatedAt: null, corrupt: false };
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('不是 JSON 对象');
    return {
      paused: raw.paused === true,
      pausedAt: raw.pausedAt ?? null,
      pausedWhy: raw.pausedWhy ?? null,
      updatedAt: raw.updatedAt ?? null,
      corrupt: false,
    };
  } catch (e) {
    // fail-closed：读不出来就当「暂停」。不确定状态时开新单，可能是在日闸没生效的情况下继续烧钱。
    return {
      paused: true,
      pausedAt: null,
      pausedWhy: `状态文件损坏（${String(e.message).slice(0, 80)}）`,
      updatedAt: null,
      corrupt: true,
    };
  }
}

export function writeState(logDir, patch) {
  const next = {
    paused: patch.paused === true,
    pausedAt: patch.pausedAt ?? null,
    pausedWhy: patch.pausedWhy ?? null,
    updatedAt: new Date().toISOString(),
  };
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const f = stateFile(logDir);
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, f); // 原子替换：半截文件会让下一次读变成「损坏 → 暂停」
  return next;
}

export function setPaused(logDir, why) {
  return writeState(logDir, { paused: true, pausedAt: new Date().toISOString(), pausedWhy: String(why || '') });
}

export function clearPaused(logDir) {
  return writeState(logDir, { paused: false, pausedAt: null, pausedWhy: null });
}

// 未知旗标的黑名单：dispatch 只认下面这些。以前多写一个旗标，不是报错，而是静默起常驻进程
// （`ci/dispatch.mjs:2156` 的 `if (ONCE || DRY) return;` 之后就是 `while (true)`），
// 想看一眼状态反而把调度器点亮了——所以这里显式拒绝，宁可 exit 2。
export const KNOWN_FLAGS = ['--once', '--ensure', '--serve', '--dry-run', '--probe-stale', '--pool-snapshot', '--repos', '--status', '--pause', '--resume', '--why', '--help', '-h', '-?'];

export function parseRuntime(argv) {
  const args = argv.slice(2);
  const valueFlags = new Set(['--repos', '--why']);
  const unknown = [];
  const cmds = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) continue; // 非旗标参数（比如 `-` 读 stdin）不参与判定
    if (!KNOWN_FLAGS.includes(a)) { unknown.push(a); continue; }
    if (valueFlags.has(a)) {
      // `--why --status` 里 --status 是旗标不是值：吃掉它会让命令静默消失（掉进常驻轮询）。
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) continue;
      i += 1;
      continue;
    }
    if (a === '--status') cmds.push('status');
    else if (a === '--pause') cmds.push('pause');
    else if (a === '--resume') cmds.push('resume');
    else if (a === '--help' || a === '-h' || a === '-?') cmds.push('help');
  }
  // 多个命令同时给会静默「后写者赢」（`--pause --status` 只打状态、暂停不执行）；
  // 与其让人以为暂停了，不如报成用法错误。
  const conflict = cmds.length > 1 ? cmds.join(',') : null;
  const whyIdx = args.indexOf('--why');
  const whyRaw = whyIdx > 0 ? (args[whyIdx + 1] ?? '') : '';
  // `--why --status`：下一个是旗标，说明原因没写，别把旗标当原因。
  const why = whyRaw.startsWith('--') ? '' : whyRaw;
  return { cmd: conflict ? null : (cmds[0] ?? null), conflict, unknown, why };
}

// 只读体检的输出：一眼要能回答「谁在跑、能不能领新单、今天花了多少」。
// 用固定前缀（`mode:` / `lock:` / `pause:` / `spend:`），方便 grep，也不假装是 JSON。
export function formatStatus({ mode, lock, st, spendCny, dayMaxCny, taskMaxCny, events }) {
  const lines = [];
  lines.push(`mode: ${mode}`);
  if (!lock) {
    lines.push('lock: 无（没有调度器在跑）');
  } else {
    const beat = lock.atUnknown ? '未知（at 解析不出来）' : (lock.beatFresh ? '新鲜' : '陈旧');
    lines.push(`lock: pid=${lock.pid} mode=${lock.mode ?? '?'} 起于=${lock.at ?? '?'} ${lock.alive ? '进程活着' : '进程已死（陈旧，可接管）'} 心跳${beat}`);
  }
  lines.push(st.paused ? `pause: 是（${st.pausedWhy || '未写原因'}，自 ${st.pausedAt || '?'}）` : 'pause: 否');
  lines.push(`spend: 今日 ¥${Number(spendCny).toFixed(4)} / 日上限 ¥${Number(dayMaxCny).toFixed(2)}；单任务上限 ¥${Number(taskMaxCny).toFixed(2)}`);
  if (events && events.length) lines.push(`events: 最近 ${events.length} 条：${events.join(' | ')}`);
  return lines;
}
