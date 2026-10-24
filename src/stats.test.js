import test from 'node:test';
import assert from 'node:assert/strict';
import { average, median } from './stats.js';

test('average basic', () => {
  assert.equal(average([1, 2, 3]), 2);
  assert.equal(average([2, 4]), 3);
  assert.equal(average([5]), 5);
});

test('average empty throws RangeError', () => {
  assert.throws(() => average([]), RangeError);
});

test('median basic', () => {
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([5]), 5);
});

test('median empty throws RangeError', () => {
  assert.throws(() => median([]), RangeError);
});