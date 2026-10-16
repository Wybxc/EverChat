import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { attachmentInputSchema,attachmentSignatureMatches,MAX_ATTACHMENT_BYTES } from '../../../shared/attachments/files';

const input = { id: crypto.randomUUID(), name: '预算.md', size: 12, mediaType: 'text/markdown', sha256: 'a'.repeat(64) };
test('attachment metadata accepts bounded files and rejects unsafe paths, executable types, malformed checksums and sizes', () => {
  assert.equal(v.safeParse(attachmentInputSchema, input).success, true);
  for (const patch of [{ size: 0 }, { size: MAX_ATTACHMENT_BYTES + 1 }, { size: 1.5 }, { name: '../secret' }, { name: 'dir\\file' }, { name: 'bad\nheader' },
    { name: '   ' }, { sha256: 'A'.repeat(64) }, { mediaType: 'image/svg+xml' }, { mediaType: 'text/html' }, { key: 'private/object' }]) {
    assert.equal(v.safeParse(attachmentInputSchema, { ...input, ...patch }).success, false);
  }
});
test('file signatures reject spoofed raster and PDF types while permitting only bounded text prefixes', () => {
  assert.equal(attachmentSignatureMatches(Uint8Array.from([137,80,78,71,13,10,26,10]), 'image/png'), true);
  assert.equal(attachmentSignatureMatches(Uint8Array.from([255,216,255,224]), 'image/jpeg'), true);
  assert.equal(attachmentSignatureMatches(new TextEncoder().encode('RIFFxxxxWEBP'), 'image/webp'), true);
  assert.equal(attachmentSignatureMatches(new TextEncoder().encode('%PDF-1.7'), 'application/pdf'), true);
  for (const type of ['image/png','image/jpeg','image/webp','application/pdf'] as const) assert.equal(attachmentSignatureMatches(new TextEncoder().encode('<script>evil'), type), false);
  assert.equal(attachmentSignatureMatches(Uint8Array.from([0,1,2]), 'text/plain'), false);
  assert.equal(attachmentSignatureMatches(new TextEncoder().encode('中文代码'), 'text/plain'), true);
});
