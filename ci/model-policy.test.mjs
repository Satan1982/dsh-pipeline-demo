import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelPolicy, paidModels, modelsInPatchYaml } from './model-policy.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('付费路由与全局规范一致（~/.dsh/model-policy.json）', (t) => {
  const policy = loadModelPolicy();
  if (!policy) return t.skip('没有 model-policy.json（别的机器上不检查）');
  const allowed = paidModels(policy);
  assert.ok(allowed.size > 0, 'policy.paid.models 不能为空');

  // 1) headless 的付费 patch 只能用规范允许的模型
  const patchFile = /const PAID_PATCH = [^\n]*headless-model-(paid|strong)\.yml/.exec(read('ci/dispatch.mjs'));
  assert.ok(patchFile, 'dispatch.mjs 里找不到 PAID_PATCH');
  const patchYml = path.join(ROOT, '..', '.secrets', `headless-model-${patchFile[1]}.yml`);
  if (existsSync(patchYml)) {
    const models = modelsInPatchYaml(readFileSync(patchYml, 'utf8'));
    assert.ok(models.length > 0, '付费 patch 里没解析出模型');
    for (const m of models) assert.ok(allowed.has(m), `付费 patch 用了规范外的模型：${m}`);
  }

  // 2) 评审的升级档默认值也必须来自规范
  const m = /export const PAID_REVIEW_MODELS = \(process\.env\.DSH_REVIEW_PAID_MODELS \|\| '([^']+)'\)/.exec(read('ci/semantic-review.mjs'));
  assert.ok(m, 'semantic-review.mjs 里找不到 PAID_REVIEW_MODELS 默认值');
  for (const model of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
    assert.ok(allowed.has(model), `评审升级档用了规范外的模型：${model}`);
  }
});
