import test from 'node:test';
import assert from 'node:assert/strict';
import { average, median } from './stats.js';

test('average', () => {
  assert.equal(average([1, 2, 3]), 2);
  assert.equal(average([-2, 2]), 0);
});

test('average rejects an empty array', () => {
  assert.throws(() => average([]), RangeError);
});

test('median', () => {
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('median does not mutate its input', () => {
  const nums = [3, 1, 2];
  median(nums);
  assert.deepEqual(nums, [3, 1, 2]);
});

test('median rejects an empty array', () => {
  assert.throws(() => median([]), RangeError);
});
