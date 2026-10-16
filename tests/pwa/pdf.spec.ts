import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { textPdf } from '../fixtures/pdf';
import { estimateDocumentTokens, type DocumentPart } from '../../shared/attachments/documents';
import { PDF_PARSER_VERSION, type PDFExtraction } from '../../shared/attachments/pdf';

test('production assets load the real PDF worker and bundled Chinese CMaps and fonts without a public document URL', async ({ page }) => {
  const id = '00000000-0000-4000-8000-000000000101', bytes = textPdf([['生产构建预算：42 元。']], { unicode: true });
  let input: { id: string; name: string; sha256: string; size: number; mediaType: string } | undefined, extracted: PDFExtraction | undefined, part: DocumentPart | undefined;
  await page.route('**/api/session', (route) => route.fulfill({ json: { authenticated: true, configured: true, attachmentsConfigured: true, provider: '', model: '', models: [] } }));
  await page.route('**/api/conversations/*/attachments**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/attachments')) {
      input = request.postDataJSON(); return route.fulfill({ status: 201, json: { ...input, status: 'registered', conversationId: id, createdAt: 1, error: null } });
    }
    if (request.method() === 'PUT' && path.endsWith('/content')) {
      expect(request.postDataBuffer()).toEqual(bytes); return route.fulfill({ json: { ...input, status: 'ready', conversationId: id, createdAt: 1, error: null } });
    }
    if (request.method() === 'POST' && path.endsWith('/document')) {
      extracted = request.postDataJSON() as PDFExtraction; expect(extracted.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      part = { type: 'file', attachmentId: input!.id, name: input!.name, size: input!.size, sha256: input!.sha256, mediaType: 'application/pdf', version: 1,
        textSha256: createHash('sha256').update(extracted.text).digest('hex'), characters: extracted.text.length,
        tokens: estimateDocumentTokens({ name: input!.name, mediaType: 'application/pdf' }, extracted.text), pdf: extracted.pdf };
      return route.fulfill({ json: part });
    }
    if (request.method() === 'GET' && path.endsWith('/document')) return route.fulfill({ json: { file: part, text: extracted!.text }, headers: { 'Cache-Control': 'no-store' } });
    return route.fulfill({ json: [] });
  });
  await page.goto(`/c/${id}`); await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
  await page.getByLabel('选择聊天文件').setInputFiles({ name: '生产.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.getByRole('button', { name: '预览 生产.pdf' }).click(); await expect(page.getByRole('dialog').locator('pre')).toContainText('生产构建预算：42 元');
  expect(extracted?.pdf).toEqual({ pages: 1, parserVersion: PDF_PARSER_VERSION });
});
