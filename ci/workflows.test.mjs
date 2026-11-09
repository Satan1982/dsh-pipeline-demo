// P1-8：CI 配置的机械守卫——令牌权限必须显式，第三方 action 必须固定到提交 SHA。
// 为什么要有这个测试：`ci.yml` 原来没写 `permissions:`，仓库默认是 read/write，等于把写权限
// 隐式交给了跑 PR 代码的 job；`actions/checkout@v4` 这类浮动 tag 则允许上游改指向。
// 这两条都只在「有人手动看一眼」时才会被发现，所以钉进断言基线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');

function workflowFiles() {
  return readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}

function lines(file) {
  return readFileSync(join(WORKFLOWS, file), 'utf8').split(/\r?\n/);
}

// `uses: owner/repo@ref`；本地复合 action（./x）与 docker:// 不需要固定 SHA。
function usesEntries(file) {
  const out = [];
  lines(file).forEach((text, i) => {
    const m = /^\s*-?\s*uses:\s*(\S+)/.exec(text);
    if (!m) return;
    const spec = m[1];
    if (spec.startsWith('./') || spec.startsWith('docker://')) return;
    out.push({ file, line: i + 1, spec });
  });
  return out;
}

test('workflows: 每个 uses 都固定到 40 位提交 SHA', () => {
  const bad = [];
  for (const file of workflowFiles()) {
    for (const e of usesEntries(file)) {
      if (!/@[0-9a-f]{40}$/.test(e.spec)) bad.push(`${e.file}:${e.line} ${e.spec}`);
    }
  }
  assert.deepEqual(bad, [], `浮动 tag 或短 SHA：\n${bad.join('\n')}`);
});

test('workflows: 至少解析到两个 uses（防正则失配后测试空转）', () => {
  const all = workflowFiles().flatMap(usesEntries);
  assert.ok(all.length >= 2, `只解析到 ${all.length} 个 uses`);
  assert.ok(all.every((e) => /^[\w.-]+\/[\w.-]+@/.test(e.spec)));
});

test('workflows: 固定 SHA 的行同时标注版本（vX.Y.Z）', () => {
  const bad = [];
  for (const file of workflowFiles()) {
    for (const text of lines(file)) {
      const m = /uses:\s*\S+@[0-9a-f]{40}\s*(#\s*(.*))?$/.exec(text);
      if (!m) continue;
      const note = (m[2] || '').trim();
      if (!/^v\d+\.\d+\.\d+$/.test(note)) bad.push(`${file}: ${text.trim()}`);
    }
  }
  assert.deepEqual(bad, [], `固定 SHA 缺版本标注：\n${bad.join('\n')}`);
});

test('ci.yml: 显式声明只读令牌权限', () => {
  const text = lines('ci.yml').join('\n');
  const perms = /^permissions:\s*\n((?:\s{2}\S.*\n?)+)/m.exec(text);
  assert.ok(perms, 'ci.yml 缺少顶层 permissions');
  assert.match(perms[1], /^\s{2}contents:\s*read\s*$/m);
  assert.doesNotMatch(perms[1], /:\s*write\s*$/m);
});

test('release.yml: 保留 contents: write（发布需要）', () => {
  const text = lines('release.yml').join('\n');
  assert.match(text, /^permissions:\s*\n\s{2}contents:\s*write\s*$/m);
});

test('workflows: 不残留浮动 tag 形式的 action 引用', () => {
  const bad = workflowFiles().flatMap((f) => usesEntries(f))
    .filter((e) => /@(v\d+|main|master)$/.test(e.spec));
  assert.deepEqual(bad, [], bad.map((e) => `${e.file}:${e.line} ${e.spec}`).join('\n'));
});
