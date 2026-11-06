// 无人值守的 intake 闸：派单自带「真能失败」的验收命令。
//
// 为什么不是协议自律：协议条写在提示词里，没人执行；`### 验收命令` 虽然有代码闸
// （dispatch.mjs 缺段即 block），但一段 `echo ok` 同样能过。人不在时，验收命令是
// 唯一裁判，裁判必须是可判负的。
//
// 这里只做启发式判定，不执行命令（执行由 dispatch 做）。宁可误拒一条 `echo`，
// 也不让人不在时出现「永远绿」的验收。
const ALWAYS_PASS = new Set(['true', ':', 'pwd', 'whoami', 'date', 'echo', 'printf', 'exit']);

// 拆行：去掉空行、注释、常见缩进；保留原句给报错看。
export function splitCommands(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// 命令「永远成功」，或把失败吞掉 → 返回原因；否则 null。
export function unfalsifiableReason(line) {
  const cmd = String(line ?? '').trim();
  if (!cmd) return '空命令';
  // `cmd || true` / `cmd || :`：失败被吞，退出码恒 0。
  if (/\|\|\s*(true|:)\s*$/.test(cmd)) return '`|| true` 吞掉了失败';
  // `cmd 2>&1 | tail -n`：管道退出码取 tail，恒 0（没开 pipefail 时）。
  if (/\|\s*(tail|head)(\s|$)/.test(cmd)) return '管道接到 tail/head，退出码恒为 0';
  // 去掉前置赋值与 `cd ... &&` 后再看首词。
  const bare = cmd
    .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
    .replace(/^(?:cd\s+\S+\s*&&\s*)+/, '')
    .trim();
  const head = bare.split(/\s+/)[0] ?? '';
  if (ALWAYS_PASS.has(head)) return `「${head}」不看任务结果，永远成功`;
  if (/^exit\s+0$/.test(bare)) return '`exit 0` 永远成功';
  return null;
}

// labels: 工单标签；acceptanceCmds: 已剥围栏的 `### 验收命令` 正文。
export function checkUnattendedIntake({ acceptanceCmds, labels = [] } = {}) {
  const cmds = splitCommands(acceptanceCmds);
  if (!cmds.length) {
    return {
      ok: false,
      reason: '无人值守派单必须自带 `### 验收命令`：人不在，没有可执行验收就没有裁判（不接受空验收）',
    };
  }
  if ((labels ?? []).includes('acceptance:optional')) {
    return {
      ok: false,
      reason: '无人值守不接受 `acceptance:optional`：豁免等于把「做完没有」交给 agent 自述',
    };
  }
  for (const cmd of cmds) {
    const why = unfalsifiableReason(cmd);
    if (why) {
      return { ok: false, reason: `验收命令不可判负（${why}）：\n${cmd}` };
    }
  }
  // verdict:strict 的下游裁决（ci/verdict.mjs:47）要求输出里有 `VERDICT:` 行，否则 exit=0 也算
  // unknown → 判失败。这条只有跑到验收阶段才暴露（实测 2026-11-07 issue #98 连挂 2 次）。
  // 例外：直接跑仓内门禁脚本时，脚本自己打印裁决行（scripts/verify.sh 末尾就有）。
  const strictVerdict = (labels ?? []).includes('verdict:strict');
  if (strictVerdict) {
    const printsVerdict = /VERDICT/i.test(String(acceptanceCmds ?? ''));
    const gateScript = cmds.every((c) => /^(?:bash|sh|node)\s+scripts\//.test(c));
    if (!printsVerdict && !gateScript) {
      return {
        ok: false,
        reason: '`verdict:strict` 要求验收命令打印 `VERDICT: PASS`（否则 exit=0 也判 unknown）：'
          + '给命令补 `&& echo "VERDICT: PASS"`，或直接跑 `bash scripts/verify.sh`（门禁脚本自己打印裁决行）',
      };
    }
  }
  return { ok: true, commands: cmds.length };
}
