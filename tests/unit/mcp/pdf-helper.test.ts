import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { extractMcpPdf } from '../../../scripts/mcp/pdf';
import { textPdf } from '../../support/assets/pdf';
test('local MCP PDF helper extracts all pages and matches the original byte hash without network resources', async () => {
  const bytes = textPdf([['Version one.'], ['Version two.']]);
  const sha256 = createHash('sha256').update(bytes).digest('hex'),
    result = await extractMcpPdf(bytes, sha256);
  assert.equal(result.sourceSha256, sha256);
  assert.equal(result.pdf.pages, 2);
  assert(result.text.includes('Version one.'));
  assert(result.text.includes('Version two.'));
  assert.equal(result.pageOffsets?.length, 2);
});
