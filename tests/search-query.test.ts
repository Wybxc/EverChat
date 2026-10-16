import { test } from 'node:test';
import assert from 'node:assert/strict';
import { literalGlob, searchCandidateGlob } from '../shared/search';

test('search candidates fit the DO 50-byte pattern limit without splitting UTF-8 or escaped glob characters', () => {
  for (const text of ['a'.repeat(200), '中'.repeat(200), '😀'.repeat(200), '[*?'.repeat(60), '远端新增版本9bbc4549-8e94-4a7f-b998-72c3d7a8c5df']) {
    const pattern = searchCandidateGlob(text), bytes = new TextEncoder().encode(pattern);
    assert(bytes.byteLength <= 50);
    assert.equal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes), pattern);
    const unescaped = pattern.slice(1, -1).replace(/\[([\[*?])\]/gu, '$1');
    assert(text.startsWith(unescaped));
    assert.equal(pattern, literalGlob(unescaped));
  }
});
