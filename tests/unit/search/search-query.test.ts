import assert from 'node:assert/strict';
import { test } from 'node:test';
import { literalGlob, searchCandidateGlob, searchMatchRanges } from '../../../shared/search/query';

test('search highlighting matches literal phrases, preserves source positions and ignores empty queries', () => {
  const text = '全文TOKEN 和 全文token · [a+b] · alpha\n beta · <script>';
  const found = (query: string) =>
    searchMatchRanges(text, query).map((r) => text.slice(r.start, r.end));
  assert.deepEqual(found('全文token'), ['全文TOKEN', '全文token']);
  assert.deepEqual(found('[a+b]'), ['[a+b]']);
  assert.deepEqual(found(' alpha  beta '), ['alpha\n beta']);
  assert.deepEqual(found('<script>'), ['<script>']);
  assert.deepEqual(found('  '), []);
  assert.deepEqual(found('.*'), []);
});

test('search candidates fit the DO 50-byte pattern limit without splitting UTF-8 or escaped glob characters', () => {
  for (const text of [
    'a'.repeat(200),
    '中'.repeat(200),
    '😀'.repeat(200),
    '[*?'.repeat(60),
    '远端新增版本9bbc4549-8e94-4a7f-b998-72c3d7a8c5df',
  ]) {
    const pattern = searchCandidateGlob(text),
      bytes = new TextEncoder().encode(pattern);
    assert(bytes.byteLength <= 50);
    assert.equal(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
      pattern,
    );
    const unescaped = pattern.slice(1, -1).replace(/\[([\[*?])\]/gu, '$1');
    assert(text.startsWith(unescaped));
    assert.equal(pattern, literalGlob(unescaped));
  }
});
