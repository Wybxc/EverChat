import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { estimateDocumentTokens, type DocumentPart } from '../../shared/attachments/documents';
import { PDF_PARSER_VERSION, type PDFExtraction } from '../../shared/attachments/pdf';
import { textPdf } from '../support/assets/pdf';

test('production assets load the real PDF worker and bundled Chinese CMaps and fonts without a public document URL', async ({
  page,
  context,
}) => {
  const id = '00000000-0000-4000-8000-000000000101',
    bytes = textPdf([['生产构建预算：42 元。']], { unicode: true });
  let input:
      { id: string; name: string; sha256: string; size: number; mediaType: string } | undefined,
    extracted: PDFExtraction | undefined,
    part: DocumentPart | undefined;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        identity: {
          issuer: 'http://everchat.local.invalid',
          sub: 'local-developer',
          email: 'developer@everchat.local',
        },
        logoutUrl: '/cdn-cgi/access/logout',
        attachmentsConfigured: true,
        provider: '',
        model: '',
        models: [],
      },
    }),
  );
  await page.route('**/api/conversations/*/attachments**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/attachments')) {
      input = request.postDataJSON();
      return route.fulfill({
        status: 201,
        json: { ...input, status: 'registered', conversationId: id, createdAt: 1, error: null },
      });
    }
    if (request.method() === 'PUT' && path.endsWith('/content')) {
      expect(request.postDataBuffer()).toEqual(bytes);
      return route.fulfill({
        json: { ...input, status: 'ready', conversationId: id, createdAt: 1, error: null },
      });
    }
    if (request.method() === 'POST' && path.endsWith('/document')) {
      expect(request.headers()['content-type']).toBe('application/vnd.everchat.pdf-text');
      const body = request.postDataBuffer()!.toString('utf8'),
        newline = body.indexOf('\n');
      extracted = {
        ...JSON.parse(body.slice(0, newline)),
        text: body.slice(newline + 1),
      } as PDFExtraction;
      expect(extracted.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      part = {
        type: 'file',
        attachmentId: input!.id,
        name: input!.name,
        size: input!.size,
        sha256: input!.sha256,
        mediaType: 'application/pdf',
        version: 1,
        textSha256: createHash('sha256').update(extracted.text).digest('hex'),
        characters: extracted.text.length,
        tokens: estimateDocumentTokens(
          { name: input!.name, mediaType: 'application/pdf' },
          extracted.text,
        ),
        pdf: extracted.pdf,
      };
      return route.fulfill({ json: part });
    }
    if (request.method() === 'GET' && path.endsWith('/document'))
      return route.fulfill({
        json: { file: part, text: extracted!.text, pageOffsets: extracted!.pageOffsets },
        headers: { 'Cache-Control': 'no-store' },
      });
    return route.fulfill({ json: [] });
  });
  await page.goto(`/c/${id}`);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state))
    .toBe('activated');
  await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
  await page
    .getByLabel('选择聊天文件')
    .setInputFiles({ name: '生产.pdf', mimeType: 'application/pdf', buffer: bytes });
  await page.getByRole('button', { name: '预览 生产.pdf' }).click();
  await expect(page.getByRole('dialog').locator('pre')).toContainText('生产构建预算：42 元');
  expect(extracted?.pdf).toEqual({ pages: 1, parserVersion: PDF_PARSER_VERSION });
  const parserUrl = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map(({ name }) => name)
      .find((url) => /\/chat-pdf-[\w-]+\.js$/.test(url))!,
  );
  await expect
    .poll(() => page.evaluate(async (url) => Boolean(await caches.match(url)), parserUrl))
    .toBe(true);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  await cdp.detach();
  await context.setOffline(true);
  try {
    await page.reload();
    // Parsing is local; uploading remains online-only. A fresh page must load the
    // actual parser, worker and Chinese font resources solely from the module cache.
    const result = await page.evaluate(
      async ({ url, bytes, sha }) => {
        const parser = await import(url);
        return parser.prepareChatPdf(
          new File([new Uint8Array(bytes)], '离线.pdf', { type: 'application/pdf' }),
          sha,
          new AbortController().signal,
        );
      },
      { url: parserUrl, bytes: [...bytes], sha: createHash('sha256').update(bytes).digest('hex') },
    );
    expect(result.text).toBe(extracted!.text);
    expect(result.pdf).toEqual({ pages: 1, parserVersion: PDF_PARSER_VERSION });
  } finally {
    await context.setOffline(false);
  }
});
