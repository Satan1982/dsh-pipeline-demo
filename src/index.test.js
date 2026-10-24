import test from 'node:test';
import assert from 'node:assert/strict';
import { add, minOf, subtract, multiply, fib, divide } from './index.js';

test('add', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('subtract', () => {
  assert.equal(subtract(5, 3), 2);
  assert.equal(subtract(2, 5), -3);
  assert.equal(subtract(-1, -4), 3);
  assert.equal(subtract(-1, 1), -2);
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

test('divide', () => {
  assert.equal(divide(6, 3), 2);
  assert.equal(divide(10, 2), 5);
});

test('minOf', () => {
  assert.equal(minOf(3, 9), 3);
  assert.equal(minOf(-2, -5), -5);
  assert.equal(minOf(5, 5), 5);
});

test('divide rejects zero divisor', () => {
  assert.throws(() => divide(1, 0), RangeError);
});
