import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepos, childEnv, formatPlan } from '../ci/repos.mjs';

test('parseRepos：字符串数组，目录默认取仓库名（相对 baseDir）', () => {
  const { entries, errors } = parseRepos(['Satan1982/a', 'Satan1982/b'], { baseDir: '/d/code' });
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => e.repo), ['Satan1982/a', 'Satan1982/b']);
  assert.ok(entries[0].dir.replace(/\\/g, '/').endsWith('code/a'));
});

test('parseRepos：对象写法带 dir，相对路径按 baseDir 解析', () => {
  const { entries, errors } = parseRepos({ repos: [{ repo: 'o/x', dir: 'sub/x' }] }, { baseDir: '/d/code' });
  assert.deepEqual(errors, []);
  assert.ok(entries[0].dir.replace(/\\/g, '/').endsWith('code/sub/x'));
});

test('parseRepos：非法 repo、重复、空清单都进 errors 而不是抛异常', () => {
  assert.equal(parseRepos(['not-a-repo']).entries.length, 0);
  assert.match(parseRepos(['not-a-repo']).errors[0], /owner\/name/);
  const dup = parseRepos(['o/a', 'O/A']);
  assert.equal(dup.entries.length, 1);
  assert.match(dup.errors[0], /重复/);
  assert.match(parseRepos([]).errors[0], /空/);
  assert.match(parseRepos(null).errors[0], /数组/);
});

test('parseRepos：一半合法一半非法时，合法的照样能用', () => {
  const { entries, errors } = parseRepos(['o/a', 'bad'], { baseDir: '/d' });
  assert.equal(entries.length, 1);
  assert.equal(errors.length, 1);
});

test('childEnv：只覆盖三个变量，并带 DSH_REPOS_CHILD 防套娃', () => {
  const env = childEnv({ repo: 'o/a', dir: 'D:/code/a' }, { PATH: 'p', DSH_REPO: 'main/one' });
  assert.equal(env.PATH, 'p');
  assert.equal(env.DSH_REPO, 'o/a');
  assert.equal(env.DSH_REPOS_CHILD, '1');
  assert.ok(env.DSH_LOG_DIR.endsWith('a/.logs') || env.DSH_LOG_DIR.endsWith('a\\.logs'));
  assert.ok(env.DSH_WORKTREES.includes('.worktrees'));
});

test('formatPlan：一行一个库，路径用正斜杠，空清单也有话说', () => {
  const lines = formatPlan([{ repo: 'o/a', dir: 'D:\\code\\a' }]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('o/a  →  D:/code/a'));
  assert.match(lines[0], /\.logs/);
  assert.deepEqual(formatPlan([]), ['（没有可用的库）']);
});
