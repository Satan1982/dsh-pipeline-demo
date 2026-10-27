import test from 'node:test';
import assert from 'node:assert/strict';
import { graphMermaid, graphText, parseTasks, topoLevels } from './plan.mjs';

const MD = `
| 任务 | 说明 | 依赖 | 验收命令 |
|---|---|---|---|
| T1 | 存储层 | - | \`node -e "console.log('VERDICT: PASS')"\` |
| T2 | 记账接口 | T1 | \`node -e "console.log('VERDICT: PASS')"\` |
| T3 | 统计 | T1,T2 | \`node -e "console.log('VERDICT: PASS')"\` |
| T4 | CLI | T2 | \`node -e "console.log('VERDICT: PASS')"\` |
`;

test('解析任务表：忽略表头与分隔线，依赖与命令都取到', () => {
  const tasks = parseTasks(MD);
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map((t) => t.id), ['T1', 'T2', 'T3', 'T4']);
  assert.deepEqual(tasks[2].deps, ['T1', 'T2']);
  assert.match(tasks[0].cmd, /VERDICT: PASS/);
  assert.deepEqual(tasks[0].deps, []);
});

test('依赖分层：T1 第 1 层，T2 第 2 层，T3/T4 第 3 层', () => {
  const lv = topoLevels(parseTasks(MD));
  const map = Object.fromEntries(lv.map((t) => [t.id, t.level]));
  // 层级 = 最长依赖链的长度：T4 依赖 T2（第 2 层），所以它也在第 3 层
  assert.deepEqual(map, { T1: 0, T2: 1, T3: 2, T4: 2 });
  const text = graphText(parseTasks(MD));
  assert.match(text, /第 1 层（起点）：T1/);
  assert.match(text, /第 3 层（集成）：T3 .*T4/);
});


test('验收命令里的 || 不会被当成表格分隔符', () => {
  const md = '| T1 | 布尔或 | - | `node -e "if (1 || 0) console.log(1)"` |';
  const [t] = parseTasks(md);
  assert.match(t.cmd, /1 \|\| 0/);
});

test('依赖成环会报错而不是死循环', () => {
  const cyclic = '| T1 | a | T2 | x |\n| T2 | b | T1 | y |';
  assert.throws(() => topoLevels(parseTasks(cyclic)), /依赖成环/);
});

test('mermaid 图包含每个任务节点和依赖边', () => {
  const m = graphMermaid(parseTasks(MD));
  assert.match(m, /T1\["T1 存储层"\]/);
  assert.match(m, /T1 --> T2/);
  assert.match(m, /T2 --> T3/);
});
