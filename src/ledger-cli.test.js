import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAddArgs } from './ledger-cli.js';

const CLI = fileURLToPath(new URL('./ledger-cli.js', import.meta.url));

function runAdd(args) {
  return spawnSync(process.execPath, [CLI, 'add', ...args], { encoding: 'utf8' });
}

function withTempFile(callback) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-cli-'));
  try {
    callback(join(dir, 'ledger.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseAddArgs parses the add options', () => {
  const args = parseAddArgs(['--date', '2026-10-01', '--amount', '100', '--note', 'salary', '--file', 'ledger.json']);
  assert.deepEqual(args, { date: '2026-10-01', amount: 100, note: 'salary', file: 'ledger.json' });
});

test('parseAddArgs rejects an invalid date', () => {
  assert.throws(() => parseAddArgs(['--date', '2026-02-30', '--amount', '100']), TypeError);
});

test('parseAddArgs rejects a non-numeric amount', () => {
  assert.throws(() => parseAddArgs(['--date', '2026-10-01', '--amount', 'salary']), TypeError);
});

test('parseAddArgs rejects a blank amount', () => {
  assert.throws(() => parseAddArgs(['--date', '2026-10-01', '--amount', '  ']), TypeError);
});

test('parseAddArgs rejects a duplicated flag instead of silently overwriting it', () => {
  assert.throws(() => parseAddArgs(['--date', '2026-10-01', '--amount', '100', '--note', 'a', '--note', 'b']), TypeError);
  assert.throws(() => parseAddArgs(['--date', '2026-10-01', '--amount', '100', '--amount', '200']), TypeError);
});

test('add writes one entry to a new JSON array file', () => {
  withTempFile((file) => {
    const result = runAdd(['--date', '2026-10-01', '--amount', '100', '--note', 'salary', '--file', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [
      { date: '2026-10-01', amount: 100, note: 'salary' },
    ]);
  });
});

test('add appends to an existing ledger', () => {
  withTempFile((file) => {
    writeFileSync(file, JSON.stringify([{ date: '2026-09-30', amount: -20, note: 'lunch' }]), 'utf8');
    const result = runAdd(['--date', '2026-10-01', '--amount', '100', '--file', file]);
    assert.equal(result.status, 0, result.stderr);
    const entries = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(entries.length, 2);
    assert.equal(entries[1].amount, 100);
  });
});

test('add rejects an invalid date without touching the file', () => {
  withTempFile((file) => {
    const result = runAdd(['--date', '2026-02-30', '--amount', '100', '--file', file]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(file), false);
  });
});
