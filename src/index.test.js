import test from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract, multiply, fib, divide, minOf, maxOf, clamp, roundTo, powOf, square, cube, isEven, isOdd, toCelsius, toFahrenheit, sumRange, absValue } from './index.js';

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

test('divide rejects zero divisor', () => {
  assert.throws(() => divide(1, 0), RangeError);
});

test('minOf', () => {
  assert.equal(minOf(3, 9), 3);
  assert.equal(minOf(-2, -5), -5);
  assert.equal(minOf(5, 5), 5);
});

test('maxOf', () => {
  assert.equal(maxOf(3, 9), 9);
  assert.equal(maxOf(-2, -5), -2);
  assert.equal(maxOf(7, 7), 7);
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
});

test('roundTo', () => {
  assert.equal(roundTo(3.14159, 2), 3.14);
  assert.equal(roundTo(2.5, 0), 3);
  assert.equal(roundTo(1.2345, 3), 1.235);
  assert.equal(roundTo(0, 2), 0);
});

test('powOf', () => {
  assert.equal(powOf(2, 3), 8);
  assert.equal(powOf(9, 0), 1);
  assert.equal(powOf(3, 2), 9);
  assert.equal(powOf(-2, 3), -8);
  assert.equal(powOf(2, -1), 0.5);
});

test('square', () => {
  assert.equal(square(4), 16);
  assert.equal(square(-3), 9);
});

test('cube', () => {
  assert.equal(cube(2), 8);
  assert.equal(cube(-2), -8);
});

test('isEven', () => {
  assert.equal(isEven(4), true);
  assert.equal(isEven(3), false);
});

test('isOdd', () => {
  assert.equal(isOdd(3), true);
  assert.equal(isOdd(0), false);
});

test('toCelsius', () => {
  assert.equal(toCelsius(32), 0);
  assert.equal(toCelsius(212), 100);
});

test('toFahrenheit', () => {
  assert.equal(toFahrenheit(0), 32);
  assert.equal(toFahrenheit(100), 212);
});

test('sumRange', () => {
  assert.equal(sumRange(1, 5), 15);
  assert.equal(sumRange(3, 3), 3);
  assert.throws(() => sumRange(5, 1), RangeError);
});

test('absValue', () => {
  assert.equal(absValue(-5), 5);
  assert.equal(absValue(0), 0);
  assert.equal(absValue(3), 3);
});

test('absValue rejects non-finite input', () => {
  assert.throws(() => absValue("x"), TypeError);
});
