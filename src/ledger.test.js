import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, summarize } from './ledger.js';

test('addEntry appends an entry without mutating the input array', () => {
  const entries = [];
  const next = addEntry(entries, { date: '2026-10-01', amount: 100, note: '工资' });
  assert.deepEqual(next, [{ date: '2026-10-01', amount: 100, note: '工资' }]);
  assert.equal(entries.length, 0);
  assert.notEqual(next, entries);
});

test('addEntry rejects a non-numeric amount', () => {
  assert.throws(() => addEntry([], { date: '2026-10-01', amount: '100', note: '工资' }), TypeError);
  assert.throws(() => addEntry([], { date: '2026-10-01', amount: Number.NaN, note: '工资' }), TypeError);
});

test('addEntry rejects an invalid date', () => {
  assert.throws(() => addEntry([], { date: '2026-1-1', amount: 100, note: '工资' }), TypeError);
  assert.throws(() => addEntry([], { date: '2026-02-30', amount: 100, note: '工资' }), TypeError);
});

test('summarize separates income and expense', () => {
  const entries = [
    { date: '2026-10-01', amount: 100, note: '工资' },
    { date: '2026-10-02', amount: -30, note: '午饭' },
    { date: '2026-10-03', amount: 20, note: '红包' },
  ];
  assert.deepEqual(summarize(entries, '2026-10'), { income: 120, expense: 30, balance: 90 });
});

test('summarize ignores entries from other months', () => {
  const entries = [
    { date: '2026-09-30', amount: 50, note: '上月' },
    { date: '2026-10-01', amount: -10, note: '本月' },
  ];
  assert.deepEqual(summarize(entries, '2026-10'), { income: 0, expense: 10, balance: -10 });
});

test('summarize returns zeros for an unknown month', () => {
  assert.deepEqual(summarize([], '2025-01'), { income: 0, expense: 0, balance: 0 });
});

test('summarize does not count a zero amount', () => {
  const entries = [{ date: '2026-10-01', amount: 0, note: '抹零' }];
  assert.deepEqual(summarize(entries, '2026-10'), { income: 0, expense: 0, balance: 0 });
});

test('summarize rejects an invalid month', () => {
  assert.throws(() => summarize([], '2026-13'), TypeError);
  assert.throws(() => summarize([], '2026-1'), TypeError);
});