#!/usr/bin/env node
// ci/drills/security.mjs — 恶意输入回归（docs/security-remediation-20261109.md §四 P2、§六/§七 闸门 2）。
//
// 判据与 ci/drills/run.mjs 一致：负例必须全被拒，另加一条正对照（正常门禁命令必须放行），
// 否则「验证器一律拒」也能过，等于没测。**只调用真实门禁函数做判定，不执行任何恶意命令**——
// 这里测的是 commandPolicy()/reviewDiff() 的判定，不是沙箱本身（沙箱在低权通道，另有 selftest）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { commandPolicy } from '../s4-exec.mjs';
import { reviewDiff } from '../review.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(readFileSync(path.join(HERE, 'security.json'), 'utf8'));

let rejected = 0;
let failed = 0;
let controls = 0;

for (const c of cases) {
  try {
    if (c.kind === 'command-policy') {
      const r = commandPolicy(c.cmd);
      if (c.control) {
        assert.equal(r.ok, true, `正对照应放行，实际被拒：${r.reason}`);
        controls += 1;
        console.log(`CONTROL-OK ${c.id}: ${c.why}`);
      } else {
        assert.equal(r.ok, false, `${c.id} 竟然被放行：${c.cmd}`);
        rejected += 1;
        console.log(`REJECT ${c.id}: ${r.reason}`);
      }
    } else if (c.kind === 'diff-review') {
      const r = reviewDiff({ files: c.files });
      assert.equal(r.ok, false, `${c.id} 竟然被放行`);
      const hit = r.findings.find((f) => f.rule === c.expectRule && f.severity === 'block');
      assert.ok(hit, `${c.id} 没有被 ${c.expectRule} 挡住，findings=${JSON.stringify(r.findings)}`);
      rejected += 1;
      console.log(`REJECT ${c.id}: ${hit.rule} — ${hit.message.slice(0, 80)}`);
    } else {
      throw new Error(`未知用例类型：${c.kind}`);
    }
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${c.id}: ${e.message}`);
  }
}

const negative = cases.filter((c) => !c.control).length;
if (failed || rejected !== negative) {
  console.log(`\n${rejected}/${negative} 例被拒（${failed} 例失败，正对照 ${controls})`);
  console.log('VERDICT: FAIL 恶意用例未全部被拒');
  process.exit(1);
}
console.log(`\n${rejected}/${negative} 例被拒（正对照 ${controls} 通过）`);
console.log('VERDICT: PASS');
