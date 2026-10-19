import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as v from 'valibot';
import {
  documentPartSchema,
  documentPrompt,
  estimateDocumentTokens,
} from '../../../shared/attachments/documents';
import {
  PDF_PARSER_VERSION,
  pdfExtractionSchema,
  validatePdfText,
} from '../../../shared/attachments/pdf';
import { pageRanges } from '../../../shared/attachments/pdf-selection';
import { abortable } from '../../../src/platform/abort';

const text = '[第 1 页]\n文件预算：42 元。',
  hash = createHash('sha256').update(text).digest('hex');
const metadata = { pages: 1, parserVersion: PDF_PARSER_VERSION } as const;
test('page selections normalize order, duplicates and adjacent pages while preserving original offsets', () => {
  assert.deepEqual(pageRanges('3, 1-2, 2', [0, 10, 20], 30), [{ start: 0, end: 30 }]);
  assert.deepEqual(pageRanges('1,3', [0, 10, 20], 30), [
    { start: 0, end: 10 },
    { start: 20, end: 30 },
  ]);
  for (const value of ['0', '4', '2-1', '1,,2', '1.5', ''])
    assert.throws(() => pageRanges(value, [0, 10, 20], 30));
  assert.throws(
    () =>
      validatePdfText({
        sourceSha256: 'a'.repeat(64),
        text: 'hello',
        pdf: { ...metadata, pages: 2 },
        pageOffsets: [0, 0],
      }),
    /索引/,
  );
});
test('PDF extraction and immutable references validate page, parser, original size and text boundaries separately', () => {
  const extraction = { sourceSha256: 'a'.repeat(64), text, pdf: metadata };
  assert.ok(v.safeParse(pdfExtractionSchema, extraction).success);
  assert.ok(
    v.safeParse(pdfExtractionSchema, {
      ...extraction,
      text: 'a'.repeat(64001),
      pdf: { ...metadata, pages: 51 },
    }).success,
  );
  for (const patch of [
    { sourceSha256: 'bad' },
    { pdf: { ...metadata, pages: 0 } },
    { pdf: { ...metadata, parserVersion: 'other' } },
    { original: 'base64' },
  ])
    assert.equal(v.safeParse(pdfExtractionSchema, { ...extraction, ...patch }).success, false);
  const part = {
    type: 'file',
    attachmentId: crypto.randomUUID(),
    name: 'budget.pdf',
    sha256: extraction.sourceSha256,
    size: 500000,
    mediaType: 'application/pdf',
    version: 1,
    textSha256: hash,
    characters: text.length,
    tokens: estimateDocumentTokens({ name: 'budget.pdf', mediaType: 'application/pdf' }, text),
    pdf: metadata,
  };
  assert.ok(v.safeParse(documentPartSchema, part).success);
  for (const patch of [
    { pdf: undefined },
    { size: 5242881 },
    { csv: { rows: 1, columns: 1 } },
    { mediaType: 'text/plain' },
  ])
    assert.equal(v.safeParse(documentPartSchema, { ...part, ...patch }).success, false);
  assert.ok(
    documentPrompt({ name: 'budget.pdf', mediaType: 'application/pdf' }, text).includes(
      JSON.stringify(text),
    ),
  );
});
test('cancelled dynamic loading releases the caller promptly, handles eventual rejection, and never starts a pre-aborted load', async () => {
  const abort = new AbortController();
  let reject!: (error: Error) => void;
  const pending = abortable(
    () =>
      new Promise<string>((_, fail) => {
        reject = fail;
      }),
    abort.signal,
  );
  abort.abort(new Error('route changed'));
  await assert.rejects(pending, /route changed/);
  reject(new Error('chunk failed later'));
  let calls = 0;
  await assert.rejects(
    abortable(async () => {
      calls++;
      return '';
    }, abort.signal),
    /route changed/,
  );
  assert.equal(calls, 0);
});
