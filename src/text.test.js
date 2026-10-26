import test from 'node:test';
import assert from 'node:assert/strict';
import { words, wordCount, initials, excerpt, chunk, reverseEachWord, shout, truncateWords, shortHash } from './text.js';

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

test('initials returns uppercase initials for a two-word name', () => {
  assert.equal(initials('Ada Lovelace'), 'AL');
});

test('initials uppercases every initial of a lowercase name', () => {
  assert.equal(initials('grace brewster hopper'), 'GBH');
});

test('initials collapses surrounding and repeated whitespace', () => {
  assert.equal(initials('  Ada   Lovelace  '), 'AL');
});

test('initials rejects an empty string', () => {
  assert.throws(() => initials(''), TypeError);
});

test('initials rejects non-string input', () => {
  assert.throws(() => initials(123), TypeError);
});

test('excerpt returns the first n characters with an ellipsis when longer', () => {
  assert.equal(excerpt('abcdef', 3), 'abc…');
});

test('excerpt returns the whole text when it fits within n', () => {
  assert.equal(excerpt('ab', 5), 'ab');
});

test('excerpt keeps the whole text when its length equals n', () => {
  assert.equal(excerpt('abc', 3), 'abc');
});

test('excerpt returns an empty string for non-positive n', () => {
  assert.equal(excerpt('abcdef', 0), '');
  assert.equal(excerpt('abcdef', -2), '');
});

test('excerpt rejects non-string input', () => {
  assert.throws(() => excerpt(123, 3), TypeError);
});

test('chunk splits text into fixed-length pieces', () => {
  assert.deepEqual(chunk('abcdef', 2), ['ab', 'cd', 'ef']);
});

test('chunk keeps the shorter final piece', () => {
  assert.deepEqual(chunk('abcde', 2), ['ab', 'cd', 'e']);
});

test('chunk returns an empty array for empty input', () => {
  assert.deepEqual(chunk('', 3), []);
});

test('chunk rejects a non-positive size', () => {
  assert.throws(() => chunk('abc', 0), RangeError);
  assert.throws(() => chunk('abc', -1), RangeError);
});

test('chunk rejects a non-integer size', () => {
  assert.throws(() => chunk('abc', 1.5), RangeError);
  assert.throws(() => chunk('abc', NaN), RangeError);
});

test('chunk rejects non-string input', () => {
  assert.throws(() => chunk(123, 2), TypeError);
});

test('reverseEachWord reverses each word but keeps word order', () => {
  assert.equal(reverseEachWord('ab cd'), 'ba dc');
});

test('reverseEachWord returns an empty string for empty input', () => {
  assert.equal(reverseEachWord(''), '');
});

test('reverseEachWord keeps repeated whitespace intact', () => {
  assert.equal(reverseEachWord('a  bc'), 'a  cb');
});

test('shout uppercases the text and appends an exclamation mark', () => {
  assert.equal(shout('hi'), 'HI!');
});

test('shout returns a single exclamation for empty input', () => {
  assert.equal(shout(''), '!');
});

test('shout rejects non-string input', () => {
  assert.throws(() => shout(123), TypeError);
});

test('truncateWords keeps only the first n words', () => {
  assert.equal(truncateWords('a b c d', 2), 'a b');
});

test('truncateWords returns the whole text when it has fewer words than n', () => {
  assert.equal(truncateWords('a b', 5), 'a b');
});

test('truncateWords returns an empty string for empty input', () => {
  assert.equal(truncateWords('', 3), '');
});

test('truncateWords rejects a negative word count', () => {
  assert.throws(() => truncateWords('a b', -1), RangeError);
});

test('truncateWords rejects non-string input', () => {
  assert.throws(() => truncateWords(123, 2), TypeError);
});

test('shortHash is stable across calls for the same input', () => {
  assert.equal(shortHash('hello'), shortHash('hello'));
  assert.equal(shortHash(''), shortHash(''));
});

test('shortHash returns different hashes for different inputs', () => {
  assert.notEqual(shortHash('a'), shortHash('b'));
});

test('shortHash returns h followed by six lowercase hex digits', () => {
  assert.match(shortHash('anything'), /^h[0-9a-f]{6}$/);
  assert.match(shortHash(''), /^h[0-9a-f]{6}$/);
  assert.match(shortHash('中文'), /^h[0-9a-f]{6}$/);
});

test('shortHash pins the FNV-1a 32-bit value of a known input', () => {
  assert.equal(shortHash('hello'), 'h9f2cab');
});

test('shortHash rejects non-string input', () => {
  assert.throws(() => shortHash(123), TypeError);
});
