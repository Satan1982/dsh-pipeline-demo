import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFECTS } from './seed-defects.mjs';

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

function occurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

test('种子缺陷集规模 ≥20 且 id 唯一', () => {
  assert.ok(DEFECTS.length >= 20, `只有 ${DEFECTS.length} 条`);
  const ids = new Set(DEFECTS.map((d) => d.id));
  assert.equal(ids.size, DEFECTS.length);
});

test('每条种子缺陷的 find 在当前源码里恰好出现一次', () => {
  for (const defect of DEFECTS) {
    const file = join(REPO_DIR, defect.file);
    assert.ok(existsSync(file), `${defect.id}: 源文件不存在 ${defect.file}`);
    const source = readFileSync(file, 'utf8');
    const hits = occurrences(source, defect.find);
    assert.equal(hits, 1, `${defect.id}: find 命中 ${hits} 次（源码改了就必须重算真值，不许留下失效样本）`);
    assert.notEqual(defect.replace, defect.find, `${defect.id}: replace 与 find 相同`);
  }
});

test('每条种子缺陷指向的测试文件存在', () => {
  for (const defect of DEFECTS) {
    assert.ok(existsSync(join(REPO_DIR, defect.test)), `${defect.id}: 测试文件不存在 ${defect.test}`);
  }
});

test('种子缺陷覆盖全部源码模块', () => {
  const files = new Set(DEFECTS.map((d) => d.file));
  for (const expected of ['src/index.js', 'src/ledger.js', 'src/stats.js', 'src/strings.js', 'src/text.js', 'src/ledger-cli.js']) {
    assert.ok(files.has(expected), `缺少对 ${expected} 的种子缺陷`);
  }
});
