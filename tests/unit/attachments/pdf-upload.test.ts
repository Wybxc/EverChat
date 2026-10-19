import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDF_PARSER_VERSION } from '../../../shared/attachments/pdf';
import { readPdfUpload } from '../../../worker/attachments/pdf-upload';
const metadata = { pages: 1, parserVersion: PDF_PARSER_VERSION } as const;
test('native PDF text uploads decode split UTF-8 and metadata safely without embedding the full text in JSON', async () => {
  const content = '全文🙂\n'.repeat(20000),
    input = { sourceSha256: 'a'.repeat(64), pdf: metadata, pageOffsets: [0] };
  const bytes = new TextEncoder().encode(JSON.stringify(input) + '\n' + content);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + 127));
      offset += 127;
    },
  });
  assert.deepEqual(await readPdfUpload(body), { ...input, text: content });
  await assert.rejects(readPdfUpload(new Response('not JSON\ntext').body!), /无效/);
  await assert.rejects(readPdfUpload(new Response(JSON.stringify(input) + '\n').body!), /无效/);
});
