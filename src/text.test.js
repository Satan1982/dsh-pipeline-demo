import test from 'node:test';
import assert from 'node:assert/strict';
import { words, wordCount } from './text.js';

test('words splits text on whitespace and drops empty strings', () => {
  assert.deepEqual(words('a b  c'), ['a', 'b', 'c']);
});

test('words returns an empty array for empty input', () => {
  assert.deepEqual(words(''), []);
});

test('words ignores leading and trailing whitespace', () => {
  assert.deepEqual(words('  a\tb\n '), ['a', 'b']);
});

test('wordCount counts the words in a text', () => {
  assert.equal(wordCount('a b c'), 3);
});

test('wordCount returns 0 for empty input', () => {
  assert.equal(wordCount(''), 0);
});
