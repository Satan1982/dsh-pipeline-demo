import test from 'node:test';
import assert from 'node:assert/strict';
import { add, multiply, fib } from './index.js';

test('add', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('multiply', () => {
  assert.equal(multiply(2, 3), 6);
  assert.equal(multiply(0, 9), 0);
});

test('fib', () => {
  assert.equal(fib(0), 0);
  assert.equal(fib(1), 1);
  assert.equal(fib(10), 55);
});

test('fib rejects bad input', () => {
  assert.throws(() => fib(-1), TypeError);
  assert.throws(() => fib(1.5), TypeError);
});
