import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countMatches, matchAt } from '../src/features/chat/search';

test('conversation search treats metacharacters as literal text and ignores case without changing UTF-16 offsets', () => {
  const text = '😀 中文 [a+b] and [A+B]';
  assert.equal(countMatches(text, '[a+b]'), 2);
  const match = matchAt(text, '[a+b]', 1)!;
  assert.equal(text.slice(match.start, match.end), '[A+B]');
  assert.equal(matchAt(text, '[a+b]', 2), null);
  assert.equal(countMatches(text, '\\('), 0);
});

test('conversation search joins a phrase across rendered whitespace and never matches an empty query', () => {
  const text = '先说 hello\n world，再说 HELLO  WORLD。';
  assert.equal(countMatches(text, ' hello world '), 2);
  const match = matchAt(text, 'hello world', 0)!;
  assert.equal(text.slice(match.start, match.end), 'hello\n world');
  assert.equal(countMatches(text, '   '), 0);
  assert.equal(matchAt(text, '', 0), null);
  assert.equal(matchAt(text, 'hello', -1), null);
});

test('conversation search counts a frequent query without truncating results and can locate its last occurrence', () => {
  const text = '查找😀 '.repeat(25_000);
  assert.equal(countMatches(text, '查找'), 25_000);
  assert.deepEqual(matchAt(text, '查找', 24_999), { start: 24_999 * 5, end: 24_999 * 5 + 2 });
});
