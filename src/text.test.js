import test from 'node:test';
import assert from 'node:assert/strict';
import { words, wordCount, initials, excerpt, chunk, reverseEachWord, shout } from './text.js';

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
