import test from 'node:test';
import assert from 'node:assert/strict';
import { capitalize, countVowels, isPalindrome, repeatText, reverseWords } from './strings.js';

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

test('reverseWords reverses word order', () => {
  assert.equal(reverseWords('hello world'), 'world hello');
});

test('reverseWords returns an empty string for empty input', () => {
  assert.equal(reverseWords(''), '');
});

test('reverseWords collapses consecutive whitespace and trims the ends', () => {
  assert.equal(reverseWords('  a  b  '), 'b a');
});

test('countVowels counts vowels ignoring case', () => {
  assert.equal(countVowels('hello'), 2);
});

test('countVowels counts every uppercase vowel', () => {
  assert.equal(countVowels('AEIOU'), 5);
});

test('countVowels returns 0 for an empty string', () => {
  assert.equal(countVowels(''), 0);
});

test('capitalize uppercases the first character', () => {
  assert.equal(capitalize('abc'), 'Abc');
});

test('capitalize returns empty string for empty input', () => {
  assert.equal(capitalize(''), '');
});

test('capitalize leaves already-uppercase strings unchanged', () => {
  assert.equal(capitalize('ABC'), 'ABC');
});

test('repeatText repeats the string n times', () => {
  assert.equal(repeatText('ab', 3), 'ababab');
});

test('repeatText returns an empty string when n is 0', () => {
  assert.equal(repeatText('ab', 0), '');
});

test('repeatText returns an empty string when n is negative', () => {
  assert.equal(repeatText('ab', -2), '');
});

test('repeatText rejects non-string input', () => {
  assert.throws(() => repeatText(1, 2), TypeError);
});
