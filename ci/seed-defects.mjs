// v3 P2（docs/89 §3.5）：种子缺陷集。每一条都是「语义上真错、测试应该抓到」的改动。
//
// 为什么要有这个：测试数/断言数/指纹只能证明「测试没少」，不能证明「测试能抓错」。
// 种子缺陷集是独立真值（缺陷是人预先判定的，不靠 agent 自评），跑一遍就能报出
// 漏报数——漏报 = 门禁绿着放过去了一个真 bug。
//
// 用法：node ci/seed-defects.mjs [--json out.json] [--first-error]
// 退出码：0 = 全部被抓到；1 = 有漏报/无效样本（漏报必须修测试，不许删样本）。

import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFirstError, parseFirstError } from './metrics.mjs';

const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

// 每条：{ id, file, find, replace, test }
// find 必须在当前源码里恰好出现一次（seed-defects.test.mjs 会校验），
// 这样源码一改，目录就红，逼着人重算真值，而不是让样本悄悄失效。
export const DEFECTS = [
  { id: 'index-add-swap', file: 'src/index.js', find: 'return a + b;', replace: 'return a - b;', test: 'src/index.test.js' },
  { id: 'index-multiply-add', file: 'src/index.js', find: 'return a * b;', replace: 'return a + b;', test: 'src/index.test.js' },
  { id: 'index-divide-guard', file: 'src/index.js', find: 'if (b === 0) {', replace: 'if (b === 1) {', test: 'src/index.test.js' },
  { id: 'index-clamp-order', file: 'src/index.js', find: 'return Math.max(min, Math.min(value, max));', replace: 'return Math.max(max, Math.min(value, min));', test: 'src/index.test.js' },
  { id: 'index-roundto-drop-divide', file: 'src/index.js', find: 'return Math.round(n * factor) / factor;', replace: 'return Math.round(n * factor);', test: 'src/index.test.js' },
  { id: 'index-fib-step', file: 'src/index.js', find: 'for (let i = 0; i < n; i += 1) {', replace: 'for (let i = 0; i < n; i += 2) {', test: 'src/index.test.js' },
  { id: 'index-tocelsius-ratio', file: 'src/index.js', find: 'Math.round((f - 32) * (5 / 9) * 10) / 10', replace: 'Math.round((f - 32) * (9 / 5) * 10) / 10', test: 'src/index.test.js' },
  { id: 'index-negate-zero', file: 'src/index.js', find: 'return n === 0 ? 0 : -n;', replace: 'return -n;', test: 'src/index.test.js' },
  { id: 'index-absvalue-nan', file: 'src/index.js', find: 'if (!Number.isFinite(n)) {', replace: 'if (Number.isNaN(n)) {', test: 'src/index.test.js' },
  { id: 'index-iseven-flip', file: 'src/index.js', find: 'return Number.isInteger(n) && n % 2 === 0;', replace: 'return Number.isInteger(n) && n % 2 !== 0;', test: 'src/index.test.js' },

  { id: 'ledger-expense-sign', file: 'src/ledger.js', find: 'expense -= entry.amount;', replace: 'expense += entry.amount;', test: 'src/ledger.test.js' },
  { id: 'ledger-balance-add', file: 'src/ledger.js', find: 'balance: income - expense', replace: 'balance: income + expense', test: 'src/ledger.test.js' },
  {
    id: 'ledger-addentry-mutate',
    file: 'src/ledger.js',
    find: '  return [\n    ...entries,\n    { date: entry.date, amount: entry.amount, note: entry.note },\n  ];',
    replace: '  entries.push({ date: entry.date, amount: entry.amount, note: entry.note });\n  return entries;',
    test: 'src/ledger.test.js',
  },

  { id: 'stats-median-even', file: 'src/stats.js', find: 'return (sorted[mid - 1] + sorted[mid]) / 2;', replace: 'return sorted[mid];', test: 'src/stats.test.js' },
  { id: 'stats-average-denominator', file: 'src/stats.js', find: '/ nums.length;', replace: '/ (nums.length + 1);', test: 'src/stats.test.js' },

  { id: 'strings-vowel-case', file: 'src/strings.js', find: 'return (s.match(/[aeiou]/gi) || []).length;', replace: 'return (s.match(/[aeiou]/g) || []).length;', test: 'src/strings.test.js' },
  { id: 'strings-repeat-plus-one', file: 'src/strings.js', find: 'return s.repeat(n);', replace: 'return s.repeat(n + 1);', test: 'src/strings.test.js' },

  { id: 'text-excerpt-boundary', file: 'src/text.js', find: 'return text.length > n ? `${text.slice(0, n)}…` : text;', replace: 'return text.length >= n ? `${text.slice(0, n)}…` : text;', test: 'src/text.test.js' },
  { id: 'text-chunk-off-by-one', file: 'src/text.js', find: 'parts.push(text.slice(i, i + size));', replace: 'parts.push(text.slice(i, i + size - 1));', test: 'src/text.test.js' },
  { id: 'text-shorthash-slice', file: 'src/text.js', find: ".padStart(8, '0').slice(-6)", replace: ".padStart(8, '0').slice(0, 6)", test: 'src/text.test.js' },
  { id: 'text-truncate-one-short', file: 'src/text.js', find: "return words(text).slice(0, n).join(' ');", replace: "return words(text).slice(0, n - 1).join(' ');", test: 'src/text.test.js' },
  { id: 'text-initials-case', file: 'src/text.js', find: "return words.map((word) => word[0].toUpperCase()).join('');", replace: "return words.map((word) => word[0].toLowerCase()).join('');", test: 'src/text.test.js' },

  { id: 'cli-duplicate-off', file: 'src/ledger-cli.js', find: 'if (seen.has(flag)) {', replace: 'if (false) {', test: 'src/ledger-cli.test.js' },
  { id: 'cli-blank-amount', file: 'src/ledger-cli.js', find: "if (value.trim() === '') {", replace: "if (value === '') {", test: 'src/ledger-cli.test.js' },
];

function childEnv() {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMP', 'TEMP', 'TMPDIR'];
  const env = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function runTest(cwd, testFile, timeoutMs = 120_000) {
  return new Promise((done) => {
    const p = spawn(process.execPath, ['--test', testFile], { cwd, env: childEnv(), windowsHide: true });
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    let out = '';
    let err = '';
    let timedOut = false;
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.end();
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); done({ code: -1, out, err: `${err}${e.message}`, timedOut }); });
    p.on('close', (code) => { clearTimeout(timer); done({ code: code ?? -1, out, err, timedOut }); });
  });
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function prepareCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'seed-defects-'));
  cpSync(join(REPO_DIR, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(REPO_DIR, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'dist'), { recursive: true });
  return dir;
}

async function runOne(defect, { firstError = false } = {}) {
  const dir = prepareCopy();
  try {
    const target = join(dir, defect.file);
    const source = readFileSync(target, 'utf8');
    const occurrences = countOccurrences(source, defect.find);
    if (occurrences !== 1) {
      return { id: defect.id, status: 'invalid', occurrences, detail: `find 出现 ${occurrences} 次（要求恰好 1 次）` };
    }
    writeFileSync(target, source.replace(defect.find, defect.replace), 'utf8');
    const res = await runTest(dir, defect.test);
    const detected = res.code !== 0;
    const parsed = detected && firstError ? parseFirstError(`${res.out}\n${res.err}`) : null;
    return {
      id: defect.id,
      status: detected ? 'caught' : 'missed',
      exit: res.code,
      timedOut: res.timedOut,
      ...(parsed ? { first_error: formatFirstError(parsed), first_error_raw: parsed } : {}),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const opts = { json: null, firstError: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') { opts.json = argv[i + 1]; i += 1; continue; }
    if (argv[i] === '--first-error') { opts.firstError = true; continue; }
    throw new TypeError(`不认识的参数：${argv[i]}`);
  }
  if (argv.includes('--json') && !opts.json) throw new TypeError('--json 需要文件路径');
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const results = [];
  for (const defect of DEFECTS) {
    const result = await runOne(defect, opts);
    results.push(result);
    const mark = result.status === 'caught' ? 'CAUGHT' : result.status.toUpperCase();
    console.log(`[seed] #${String(results.length).padStart(2, '0')} ${defect.id}: ${mark}${result.first_error ? `｜first_error: ${result.first_error}` : ''}${result.detail ? `（${result.detail}）` : ''}`);
  }
  const n = results.length;
  const caught = results.filter((r) => r.status === 'caught').length;
  const missed = results.filter((r) => r.status === 'missed').length;
  const invalid = results.filter((r) => r.status === 'invalid').length;
  const summary = { n, caught, missed, invalid, missedIds: results.filter((r) => r.status !== 'caught').map((r) => r.id) };
  console.log(`[seed] 种子缺陷集：n=${n}，抓到 ${caught}，漏报 ${missed}，无效样本 ${invalid}`);
  if (opts.json) {
    writeFileSync(resolve(opts.json), `${JSON.stringify({ at: new Date().toISOString(), summary, results }, null, 2)}\n`, 'utf8');
    console.log(`[seed] 结果已写入 ${opts.json}`);
  }
  return missed === 0 && invalid === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
