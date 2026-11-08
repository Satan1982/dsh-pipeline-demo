import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCAL_MODEL, llmEntries, laneState, laneVerdict, localLaneEnabled, disabledLaneVerdict, decideRequeue } from '../ci/local-lane.mjs';

const EMB = { model_name: 'Qwen3-Embedding-0.6B-GGUF', type: 'embedding', status: 'ready', pid: 25068 };
// 目标模型 = 默认档（2026-11-07 起常驻 Qwen3-Coder-30B；9B 已退场）。
const TARGET = { model_name: DEFAULT_LOCAL_MODEL, type: 'llm', status: 'ready', is_busy: false, pid: 24864 };
// 另一只 LLM：占着槽位时我们 request 的目标就进不来。
const OTHER = { model_name: 'Qwen3.5-9B-GGUF', type: 'llm', status: 'in_use', is_busy: true, pid: 15440 };

test('llmEntries 只看 type=llm：embedding 不占 LLM 槽位', () => {
  assert.deepEqual(llmEntries({ all_models_loaded: [EMB, TARGET] }), [TARGET]);
  assert.deepEqual(llmEntries({ all_models_loaded: [EMB] }), []);
  assert.deepEqual(llmEntries({}), []);
  assert.deepEqual(llmEntries(null), []);
});

test('槽位空着（只有 embedding）算 free：预热可以 load 进来', () => {
  const lane = laneState({ all_models_loaded: [EMB] });
  assert.equal(lane.state, 'free');
  assert.equal(lane.model, DEFAULT_LOCAL_MODEL);
  assert.equal(laneVerdict(lane).ok, true);
});

test('目标模型在槽里算 ready，busy 也要如实标出来', () => {
  const idle = laneState({ all_models_loaded: [EMB, TARGET] });
  assert.equal(idle.state, 'ready');
  assert.equal(idle.busy, false);
  assert.match(laneVerdict(idle).why, /已加载/);

  const busy = laneState({ all_models_loaded: [EMB, { ...TARGET, status: 'in_use', is_busy: true }] });
  assert.equal(busy.state, 'ready');
  assert.equal(busy.busy, true);
  assert.equal(laneVerdict(busy).ok, true);
  assert.match(laneVerdict(busy).why, /排队/);
});

test('槽位被别的 LLM 占着算 occupied：不能重投（投出去必然 0 token 再挂一次）', () => {
  const lane = laneState({ all_models_loaded: [EMB, OTHER] });
  assert.equal(lane.state, 'occupied');
  assert.equal(lane.holder, OTHER.model_name);
  assert.equal(lane.busy, true);
  const v = laneVerdict(lane);
  assert.equal(v.ok, false);
  assert.match(v.why, /Qwen3.5-9B-GGUF/);
  assert.match(v.why, /单槽/);
});

test('槽位里有别的 LLM 但目标也在（多槽位的历史快照）→ 仍算 ready', () => {
  const lane = laneState({ all_models_loaded: [OTHER, TARGET] });
  assert.equal(lane.state, 'ready');
  assert.equal(lane.model, DEFAULT_LOCAL_MODEL);
});

test('laneVerdict 对未知输入不抛错，按不可用处理', () => {
  assert.equal(laneVerdict(null).ok, false);
  assert.equal(laneVerdict(undefined).ok, false);
  assert.equal(laneVerdict({}).ok, false);
});


test('本地大模型档默认停用：只有 DSH_LOCAL_LANE=1 才启用', () => {
  assert.equal(localLaneEnabled({}), false);
  assert.equal(localLaneEnabled({ DSH_LOCAL_LANE: '0' }), false);
  assert.equal(localLaneEnabled({ DSH_LOCAL_LANE: '1' }), true);
  const off = disabledLaneVerdict();
  assert.equal(off.ok, false);
  assert.equal(off.disabled, true);
  assert.match(off.why, /已停用/);
});

test('重投判据：停用本地后只看云端；开启本地时两通道任一可用', () => {
  const cloudOk = { ok: true, why: '有 2 个 ok 模型' };
  const cloudBad = { ok: false, why: '无 ok 模型' };
  // 停用本地：付费档走云端；普通档也只看云端。
  assert.equal(decideRequeue({ paid: true, cloud: cloudOk, localEnabled: false }).ok, true);
  assert.match(decideRequeue({ paid: false, cloud: cloudOk, localEnabled: false }).why, /云端可用/);
  const blocked = decideRequeue({ paid: false, cloud: cloudBad, localEnabled: false });
  assert.equal(blocked.ok, false);
  assert.match(blocked.why, /已停用/);
  // 开启本地：旧行为保留。
  assert.equal(decideRequeue({ paid: false, cloud: cloudBad, local: { ok: true, why: '槽位空闲' }, localEnabled: true }).ok, true);
  assert.equal(decideRequeue({ paid: true, cloud: cloudBad, local: { ok: true, why: '槽位空闲' }, localEnabled: true }).ok, true);
  assert.equal(decideRequeue({ paid: false, cloud: cloudBad, local: { ok: false, why: '被占' }, localEnabled: true }).ok, false);
});
