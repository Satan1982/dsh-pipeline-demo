import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ALLOW_PREFIXES, parseStatus, takeSnapshot, lineDiff, compareSnapshots, formatRepoDrift, verifyCleanVerdict,
} from './drift-guard.mjs';
import { sha256 } from './gate-snapshot.mjs';

function snap({ exclude = [], entries = [], sha } = {}) {
  const text = exclude.join('\n');
  return {
    excludeFile: 'x',
    excludeSha: sha ?? sha256(Buffer.from(text, 'utf8')),
    excludeLines: exclude,
    entries,
  };
}

test('parseStatus 解析忽略与未跟踪条目，去引号', () => {
  const got = parseStatus('!! .logs/dispatch.log\n?? "a b.txt"\n M src/x.js\n');
  assert.deepEqual(got, [
    { flag: '!!', path: '.logs/dispatch.log' },
    { flag: '??', path: 'a b.txt' },
    { flag: 'M', path: 'src/x.js' },
  ]);
});

test('快照前后一致 → 不 block', () => {
  const s = snap({ exclude: ['node_modules/'], entries: [{ flag: '!!', path: 'dist/x.tgz' }] });
  const res = compareSnapshots(s, s);
  assert.equal(res.blocked, false);
  assert.equal(res.ok, true);
});

test('.git/info/exclude 被改 → block 并报出改了哪几行', () => {
  const before = snap({ exclude: ['node_modules/', '.env'] });
  const after = snap({ exclude: ['node_modules/', '.env', 'secret-*.json'] });
  const res = compareSnapshots(before, after);
  assert.equal(res.blocked, true);
  assert.equal(res.excludeChanged, true);
  assert.deepEqual(res.excludeDiff, [{ type: '+', text: 'secret-*.json' }]);
  const text = formatRepoDrift(res);
  assert.match(text, /info\/exclude/);
  assert.match(text, /\+ secret-\*\.json/);
});

test('exclude 删除行也能报出来', () => {
  const before = snap({ exclude: ['a/', 'b/'] });
  const after = snap({ exclude: ['a/'] });
  const res = compareSnapshots(before, after);
  assert.deepEqual(res.excludeDiff, [{ type: '-', text: 'b/' }]);
});

test('主仓新增 ignored/untracked 条目 → block', () => {
  const before = snap({ entries: [{ flag: '!!', path: 'node_modules/' }] });
  const after = snap({
    entries: [
      { flag: '!!', path: 'node_modules/' },
      { flag: '??', path: 'creds-copy.json' },
    ],
  });
  const res = compareSnapshots(before, after);
  assert.equal(res.blocked, true);
  assert.deepEqual(res.added, [{ flag: '??', path: 'creds-copy.json' }]);
  assert.match(formatRepoDrift(res), /creds-copy\.json/);
});

test('新增被 .gitignore 忽略的条目（!!）→ block；dist/ 下的忽略条目放行', () => {
  const before = snap({ entries: [{ flag: '!!', path: 'node_modules/' }] });
  const after = snap({ entries: [
    { flag: '!!', path: 'node_modules/' },
    { flag: '!!', path: '.env.local' },
    { flag: '!!', path: 'dist/dsh-pipeline-demo-0.1.2.tgz' },
  ] });
  const res = compareSnapshots(before, after);
  assert.equal(res.blocked, true);
  assert.deepEqual(res.added, [{ flag: '!!', path: '.env.local' }]);
  assert.match(formatRepoDrift(res), /\.env\.local/);
});

test('既有产物目录（.logs/ .worktrees/ dist/ .backups/）新增条目不算漂移', () => {
  const before = snap({ entries: [] });
  const after = snap({
    entries: ALLOW_PREFIXES.map((p) => ({ flag: '??', path: p + 'x' })),
  });
  const res = compareSnapshots(before, after);
  assert.equal(res.blocked, false);
  assert.deepEqual(res.added, []);
});

test('lineDiff 忽略空行，同内容不产生假 diff', () => {
  assert.deepEqual(lineDiff(['a', '', 'b'], ['a', 'b']), []);
});

test('takeSnapshot 读 info/exclude 的哈希和 status 条目', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'drift-'));
  mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'info', 'exclude'), 'node_modules/\n', 'utf8');
  const run = async (_cmd, args) => {
    if (args[0] === 'rev-parse') return { code: 0, out: '.git\n', err: '', stdout: '.git\n' };
    return { code: 0, out: '!! node_modules/\n', err: '', stdout: '!! node_modules/\n' };
  };
  const s = await takeSnapshot({ repoDir: root, run });
  assert.equal(s.excludeSha, sha256(Buffer.from('node_modules/\n', 'utf8')));
  assert.deepEqual(s.entries, [{ flag: '!!', path: 'node_modules/' }]);
  assert.equal(s.excludeFile, path.join(root, '.git', 'info', 'exclude'));
});

test('verify-clean：exit 0 + VERDICT: PASS 才 ok', () => {
  assert.equal(verifyCleanVerdict({ code: 0, out: 'tests 445\nVERDICT: PASS\n' }).ok, true);
});

test('verify-clean：非 0 或没有 VERDICT 行 → head 不可复算', () => {
  assert.equal(verifyCleanVerdict({ code: 1, out: 'VERDICT: PASS\n' }).ok, false);
  const r = verifyCleanVerdict({ code: 0, out: 'all good\n' });
  assert.equal(r.ok, false);
  assert.match(r.why, /不可复算/);
});
