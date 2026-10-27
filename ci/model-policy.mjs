// 全局规范（~/.dsh/AGENTS.md「模型使用优先级」）的文字版，落成机器可读的一份，
// 好让门禁能比对「代码里的付费路由」是否还和规范一致。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const HOME = process.env.USERPROFILE || process.env.HOME || '.';

export function policyFile() {
  return process.env.DSH_MODEL_POLICY || path.join(HOME, '.dsh', 'model-policy.json');
}

export function loadModelPolicy(file = policyFile()) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function paidModels(policy) {
  return new Set((policy?.paid?.models ?? []).filter(Boolean));
}

// 从 patch yml 里抠出 `models:` 段下每个 `- id:` 的值（够用即可，YAML 库不值得引）。
export function modelsInPatchYaml(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  let inModels = false;
  for (const line of lines) {
    if (/^\s*models:\s*$/.test(line)) { inModels = true; continue; }
    if (inModels) {
      // 必须带缩进：顶层 `- id: agent-default-model` 是另一个插件条目，不是模型
      const m = /^\s+-\s*id:\s*(\S+)\s*$/.exec(line);
      if (m) out.push(m[1]);
      else if (/^\s*-?\s*[a-zA-Z]/.test(line) && !/^\s+/.test(line)) inModels = false;
    }
  }
  return out;
}
