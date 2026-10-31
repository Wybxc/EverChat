import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TextIndexer,
  indexText,
  precedingPosition,
  sampleTextRanges,
  LiteralScanner,
} from '../../../shared/attachments/text-index';
import {
  fileMediaType,
  normalizeAttachmentMediaType,
  attachmentInputSchema,
} from '../../../shared/attachments/files';
import * as v from 'valibot';

test('text format classification accepts arbitrary textual names and MIME aliases consistently', () => {
  for (const name of [
    'page.html',
    'page.HTM',
    'diagram.svg',
    'view.xhtml',
    'a.xml',
    'a.jsonl',
    '.gitignore',
    'Makefile',
    'arbitrary.unlisted',
  ])
    assert.equal(fileMediaType(name), 'text/plain', name);
  for (const mime of [
    'text/html; charset=UTF-8',
    'image/svg+xml',
    'application/xhtml+xml',
    'application/ld+json',
    'application/xml',
    'application/octet-stream',
    '',
  ])
    assert.equal(normalizeAttachmentMediaType(mime), 'text/plain', mime);
  assert.equal(fileMediaType('photo.png', 'application/octet-stream'), 'image/png');
  assert.equal(fileMediaType('diagram.svg', 'image/svg+xml'), 'text/plain');
  assert.equal(fileMediaType('unknown', 'application/zip'), 'text/plain');
  assert.equal(fileMediaType('unknown', 'image/gif'), null);
  const parsed = v.parse(attachmentInputSchema, {
    id: crypto.randomUUID(),
    name: 'page.html',
    size: 20,
    mediaType: 'text/html',
    sha256: 'a'.repeat(64),
  });
  assert.equal(parsed.mediaType, 'text/plain');
});

test('incremental text index preserves BOM, UTF-16 counts and sparse UTF-8 coordinates at every fragmentation', () => {
  const text = '\ufeff中文😀e\u0301\r\n\n' + 'x'.repeat(65530) + '😀\n' + '中'.repeat(30000);
  const bytes = new TextEncoder().encode(text),
    expected = indexText(bytes);
  assert.equal(expected.bytes, bytes.length);
  assert.equal(expected.characters, text.length);
  assert.equal(expected.lines, 1 + text.split('\n').length - 1);
  for (const chunk of [1, 2, 3, 7, 1024, 65536]) {
    const builder = new TextIndexer();
    for (let start = 0; start < bytes.length; start += chunk)
      builder.append(bytes.subarray(start, start + chunk));
    assert.deepEqual(builder.finish(), expected);
  }
  for (const point of expected.positions) {
    const prefix = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, point.byte),
    );
    assert.equal(prefix.length, point.characters);
    assert.equal(prefix.split('\n').length, point.line);
    assert.equal(precedingPosition(expected, 'byte', point.byte).byte, point.byte);
  }
  assert.equal(precedingPosition(expected, 'line', 1).byte, 0);
});

test('invalid UTF-8 or binary controls are rejected even across chunk and EOF boundaries', () => {
  for (const bytes of [
    [0xc3, 0x28],
    [0xe2, 0x82],
    [0xed, 0xa0, 0x80],
    [0xf0, 0x80, 0x80, 0x80],
    [0],
    [0x1b],
    [0x7f],
  ]) {
    assert.throws(() => {
      const builder = new TextIndexer();
      for (const byte of bytes) builder.append(Uint8Array.of(byte));
      builder.finish();
    });
  }
});

test('resumable literal search finds Unicode, overlapping and cross-block matches exactly once', () => {
  const text = 'aaaaa中文😀\n中文😀aaaaa';
  const data = new TextEncoder().encode(text);
  const patterns = [
    { id: 'overlap', literal: 'aaa' },
    { id: 'unicode', literal: '中文😀' },
    { id: 'crossline', literal: '😀\n中' },
    { id: 'none', literal: 'missing' },
  ];
  const expected: { id: string; start: number; end: number }[] = [];
  for (const { id, literal } of patterns) {
    const needle = Buffer.from(literal);
    for (
      let at = Buffer.from(data).indexOf(needle);
      at !== -1;
      at = Buffer.from(data).indexOf(needle, at + 1)
    )
      expected.push({ id, start: at, end: at + needle.length });
  }
  const sort = (a: (typeof expected)[number], b: (typeof expected)[number]) =>
    a.start - b.start || a.id.localeCompare(b.id);
  expected.sort(sort);
  for (const chunk of [1, 2, 5, 100]) {
    let scanner = new LiteralScanner(patterns);
    const found: typeof expected = [];
    for (let at = 0; at < data.length; at += chunk) {
      scanner.scan(data.subarray(at, at + chunk), at, (id, start, end) =>
        found.push({ id, start, end }),
      );
      const saved = scanner.checkpoint();
      scanner = new LiteralScanner(patterns, saved.counts, saved.states);
    }
    assert.deepEqual(found.sort(sort), expected);
    assert.deepEqual(scanner.checkpoint().counts, {
      overlap: 6,
      unicode: 2,
      crossline: 1,
      none: 0,
    });
  }
});

test('position sampling is deterministic, bounded and merges overlapping ranges', () => {
  assert.deepEqual(sampleTextRanges(1000, 3, 100), [
    { start: 0, end: 100 },
    { start: 450, end: 550 },
    { start: 900, end: 1000 },
  ]);
  assert.deepEqual(sampleTextRanges(50, 8, 100), [{ start: 0, end: 50 }]);
  assert.deepEqual(sampleTextRanges(100, 2, 60), [{ start: 0, end: 100 }]);
  assert.deepEqual(sampleTextRanges(0, 1, 100), []);
});

test('literal pattern IDs that match Object prototype names retain exact resumable counts', () => {
  const patterns = ['__proto__', 'constructor', 'toString'].map((id) => ({ id, literal: 'aaa' }));
  const first = new LiteralScanner(patterns);
  first.scan(new TextEncoder().encode('aa'), 0);
  const checkpoint = first.checkpoint();
  const resumed = new LiteralScanner(patterns, checkpoint.counts, checkpoint.states);
  resumed.scan(new TextEncoder().encode('aaa'), 2);
  assert.deepEqual(resumed.checkpoint().counts, Object.fromEntries(patterns.map((p) => [p.id, 3])));
});
