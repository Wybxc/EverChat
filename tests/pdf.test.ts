import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { pdfExtractionSchema, PDF_PARSER_VERSION } from '../shared/attachments/pdf';
import { documentPartSchema, documentPrompt, estimateDocumentTokens } from '../shared/attachments/documents';
import { abortable } from '../src/platform/abort';

const text = '[第 1 页]\n文件预算：42 元。', hash = createHash('sha256').update(text).digest('hex');
const metadata = { pages: 1, parserVersion: PDF_PARSER_VERSION };
test('PDF extraction and immutable references validate page, parser, original size and text boundaries separately', () => {
  const extraction = { sourceSha256: 'a'.repeat(64), text, pdf: metadata };
  assert.ok(v.safeParse(pdfExtractionSchema, extraction).success);
  for (const patch of [{ sourceSha256: 'bad' }, { text: 'a'.repeat(64001) }, { pdf: { ...metadata, pages: 0 } }, { pdf: { ...metadata, pages: 51 } }, { pdf: { ...metadata, parserVersion: 'other' } }, { original: 'base64' }]) assert.equal(v.safeParse(pdfExtractionSchema, { ...extraction, ...patch }).success, false);
  const part = { type: 'file', attachmentId: crypto.randomUUID(), name: 'budget.pdf', sha256: extraction.sourceSha256, size: 500000, mediaType: 'application/pdf', version: 1,
    textSha256: hash, characters: text.length, tokens: estimateDocumentTokens({ name: 'budget.pdf', mediaType: 'application/pdf' }, text), pdf: metadata };
  assert.ok(v.safeParse(documentPartSchema, part).success);
  for (const patch of [{ pdf: undefined }, { size: 5242881 }, { csv: { rows: 1, columns: 1 } }, { mediaType: 'text/plain' }]) assert.equal(v.safeParse(documentPartSchema, { ...part, ...patch }).success, false);
  assert.ok(documentPrompt({ name: 'budget.pdf', mediaType: 'application/pdf' }, text).includes(JSON.stringify(text)));
});
test('cancelled dynamic loading releases the caller promptly, handles eventual rejection, and never starts a pre-aborted load', async () => {
  const abort = new AbortController(); let reject!: (error: Error) => void;
  const pending = abortable(() => new Promise<string>((_, fail) => { reject = fail; }), abort.signal);
  abort.abort(new Error('route changed'));
  await assert.rejects(pending, /route changed/); reject(new Error('chunk failed later'));
  let calls = 0;
  await assert.rejects(abortable(async () => { calls++; return ''; }, abort.signal), /route changed/);
  assert.equal(calls, 0);
});
