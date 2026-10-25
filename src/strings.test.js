import test from 'node:test';
import assert from 'node:assert/strict';
import { isPalindrome } from './strings.js';

test('isPalindrome recognizes a classic palindrome ignoring case and punctuation', () => {
  assert.equal(isPalindrome('A man, a plan, a canal: Panama'), true);
});

test('isPalindrome returns false for a non-palindrome', () => {
  assert.equal(isPalindrome('hello'), false);
});

test('isPalindrome returns true for an empty string', () => {
  assert.equal(isPalindrome(''), true);
});

test('isPalindrome rejects non-string input', () => {
  assert.throws(() => isPalindrome(123), TypeError);
});