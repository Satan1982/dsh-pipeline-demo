// 无人值守 intake 闸的回归测试。
//
// 2026-11-06 三个评审一致指出：协议说「派单必须自带 AC 与命令原句」，代码里却
// 没有任何 intake 校验；更糟的是 `echo ok` 这种命令也能过既有的 `### 验收命令` 闸。
// 这几条断言钉住「不可判负的命令必须被拒」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCommands, unfalsifiableReason, checkUnattendedIntake } from './intake-check.mjs';

test('拆命令：去空行/注释/缩进，保留 CRLF 兼容', () => {
  assert.deepEqual(splitCommands('  npm test\r\n\r\n# 说明\necho ok  '), ['npm test', 'echo ok']);
  assert.deepEqual(splitCommands(''), []);
});

test('永远成功或吞掉失败的命令被识别', () => {
  for (const cmd of ['echo ok', 'true', ':', 'exit 0', 'pwd', 'cd sub && echo hi', 'npm test || true', 'npm test 2>&1 | tail -5']) {
    assert.notEqual(unfalsifiableReason(cmd), null, `${cmd} 应被判为不可判负`);
  }
});

test('能真失败的命令放行', () => {
  for (const cmd of ['npm test', 'node --test', 'bash scripts/verify.sh', 'false', 'node -e "process.exit(1)"']) {
    assert.equal(unfalsifiableReason(cmd), null, `${cmd} 不应被误拒`);
  }
});

test('无人值守：没验收命令 / 豁免标签 / 只 echo，一律拒单', () => {
  assert.equal(checkUnattendedIntake({ acceptanceCmds: '' }).ok, false);
  assert.equal(checkUnattendedIntake({ acceptanceCmds: 'npm test', labels: ['acceptance:optional'] }).ok, false);
  assert.equal(checkUnattendedIntake({ acceptanceCmds: 'echo "VERDICT: PASS"' }).ok, false);
  const ok = checkUnattendedIntake({ acceptanceCmds: 'npm test\nbash scripts/verify.sh' });
  assert.equal(ok.ok, true);
  assert.equal(ok.commands, 2);
});
