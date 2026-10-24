import test from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract, multiply, fib, divide, powOf } from './index.js';

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

test('powOf', () => {
  assert.equal(powOf(2, 3), 8);
  assert.equal(powOf(9, 0), 1);
  assert.equal(powOf(0, 0), 1);
  assert.equal(powOf(3, 2), 9);
  assert.equal(powOf(-2, 3), -8);
  assert.equal(powOf(2, -1), 0.5);
});
