#!/usr/bin/env node
/**
 * 静态检查「用了某个模块却没 import」这类问题。
 *
 * 为什么需要：`node --check` 只查语法。2026-10-26 两次事故都是「函数体里用了
 * `path.join(...)`，但文件没有 `import path from 'node:path'`」——
 * 语法合法、测试如果不调用那个函数也过，只有真跑到那一行才 ReferenceError，
 * 而那时已经在流水线里跑了一半（#69 因此连挂三次）。
 *
 * 这里只查最容易踩的几个调用点：path.* / readFileSync / writeFileSync / spawnSync /
 * fileURLToPath / spawn(。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const RULES = [
  { name: 'path', test: /(?<![\w.])path\./g, need: /^import\s+path\s+from\s+'node:path';/m, fix: "import path from 'node:path';" },
  { name: 'readFileSync', test: /(?<![\w.])readFileSync\(/g, need: /\breadFileSync\b/, import: /from 'node:fs'/m, fix: "import { readFileSync } from 'node:fs';" },
  { name: 'writeFileSync', test: /(?<![\w.])writeFileSync\(/g, need: /\bwriteFileSync\b/, import: /from 'node:fs'/m, fix: "import { writeFileSync } from 'node:fs';" },
  { name: 'appendFileSync', test: /(?<![\w.])appendFileSync\(/g, need: /\bappendFileSync\b/, import: /from 'node:fs'/m, fix: "import { appendFileSync } from 'node:fs';" },
  { name: 'spawnSync', test: /(?<![\w.])spawnSync\(/g, need: /\bspawnSync\b/, import: /from 'node:child_process'/m, fix: "import { spawnSync } from 'node:child_process';" },
  { name: 'fileURLToPath', test: /(?<![\w.])fileURLToPath\(/g, need: /\bfileURLToPath\b/, import: /from 'node:url'/m, fix: "import { fileURLToPath } from 'node:url';" },
];

const dirs = ['ci', 'scripts', 'src'];
const files = [];
for (const d of dirs) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs)) {
    if (/\.(mjs|js)$/.test(name)) files.push(path.join(abs, name));
  }
}

let bad = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const importBlock = src.split('\n').filter((l) => l.startsWith('import ') || l.startsWith('  ')).join('\n');
  for (const rule of RULES) {
    const hits = src.match(rule.test);
    if (!hits) continue;
    const imported = rule.import ? (src.includes(rule.name) && rule.import.test(src)) : rule.need.test(importBlock);
    if (imported) continue;
    bad += 1;
    console.error(`✗ ${path.relative(ROOT, file)} 用了 ${rule.name} 但没 import（补 ${rule.fix}）`);
  }
}

if (bad) {
  console.error(`imports: ${bad} 处缺失`);
  process.exit(1);
}
console.log(`imports OK (${files.length} files)`);
