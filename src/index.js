export function add(a, b) {
  return a + b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}

export function divide(a, b) {
  if (b === 0) {
    throw new RangeError('divide by zero');
  }
  return a / b;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

export function fib(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError('fib expects a non-negative integer');
  }
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i += 1) {
    [a, b] = [b, a + b];
  }
  return a;
}
