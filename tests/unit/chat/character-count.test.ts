import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countCharacters } from '../../../src/features/chat/character-count';

test('character counts exclude whitespace and count astral Unicode characters once', () => {
  assert.equal(countCharacters('中文 abc 🙂𠮷\n\t\r\u00a0\u3000'), 7);
  assert.equal(countCharacters(''), 0);
  assert.equal(countCharacters(' \n\t\u3000'), 0);
});

test('character counts preserve punctuation, Markdown and code instead of estimating tokens or words', () => {
  assert.equal(countCharacters('**你好！**\n`x = 1`'), 12);
  assert.equal(countCharacters('Hello world!'), 11);
});
