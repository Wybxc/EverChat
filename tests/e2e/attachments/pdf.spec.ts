import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { attachmentUrl } from '../../../shared/attachments/files';
import { PDF_PARSER_VERSION, type PDFExtraction } from '../../../shared/attachments/pdf';
import { messageFiles, messageText } from '../../../shared/conversation/content';
import type { Submission } from '../../../shared/conversation/types';
import type { ProviderKind } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { textPdf } from '../../support/assets/pdf';

const headers = { Origin: 'http://127.0.0.1:5174' },
  providerId = '00000000-0000-4000-8000-000000000090';
const control = (request: APIRequestContext, data: object = {}) =>
  request
    .post('/api/__test/library/attachments', { headers, data })
    .then((response) => response.json());
async function setup(request: APIRequestContext, provider: ProviderKind = 'openai-chat') {
  await request.post('/__dev/access/login', { headers });
  await control(request, { count: 0 });
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: 'PDF fixture',
              provider,
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: `documents-${provider}`,
                  name: 'PDF 文本模型',
                  enabled: true,
                  metadataOverrides: { imageInput: false, contextWindow: 200000 },
                },
              ],
            },
          ],
          activeProviderId: providerId,
          activeModel: `documents-${provider}`,
          systemPrompt: '',
          maxOutputTokens: null,
        },
      })
    ).ok(),
  ).toBe(true);
  const id = crypto.randomUUID();
  await request.post('/api/conversations', { headers, data: { id, title: 'PDF 测试' } });
  return {
    id,
    selection: { providerId, model: `documents-${provider}` },
    snapshot: () =>
      request
        .get(`/api/conversations/${id}`)
        .then((response) => response.json()) as Promise<Snapshot>,
    cleanup: () => request.delete(`/api/conversations/${id}`, { headers }),
  };
}
async function login(page: Page, id: string) {
  await page.goto(`/c/${id}`);
  await page.request.post('/__dev/access/login');
  await page.reload();
  await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
}
async function finish(fixture: Awaited<ReturnType<typeof setup>>, submission: Submission) {
  await expect
    .poll(
      async () =>
        (await fixture.snapshot()).messages.find((message) => message.id === submission.assistantId)
          ?.status,
    )
    .toBe('completed');
  return (await fixture.snapshot()).messages.find(
    (message) => message.id === submission.assistantId,
  )!;
}
async function upload(request: APIRequestContext, id: string, bytes = textPdf()) {
  const file = {
    id: crypto.randomUUID(),
    name: 'budget.pdf',
    size: bytes.length,
    mediaType: 'application/pdf',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  expect(
    (await request.post(`/api/conversations/${id}/attachments`, { headers, data: file })).status(),
  ).toBe(201);
  expect((await request.put(attachmentUrl(id, file.id), { headers, data: bytes })).status()).toBe(
    200,
  );
  return file;
}
const docUrl = (id: string, fileId: string) =>
  `/api/conversations/${id}/attachments/${fileId}/document`;
for (const provider of [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
] as ProviderKind[]) {
  test(`${provider}: real browser PDF extraction persists before a file-only task and survives page close with private cross-device preview`, async ({
    request,
    browser,
  }) => {
    const fixture = await setup(request, provider),
      first = await browser.newContext(),
      second = await browser.newContext();
    try {
      const page = await first.newPage();
      await login(page, fixture.id);
      const bytes = textPdf([
        ['Budget: 42.', '<script>window.pdfExecuted=true</script>'],
        ['Second page reference.'],
      ]);
      await page
        .getByLabel('选择聊天文件')
        .setInputFiles({ name: 'budget.pdf', mimeType: 'application/pdf', buffer: bytes });
      await expect(page.getByRole('button', { name: '预览 budget.pdf' })).toBeVisible();
      await page.getByRole('button', { name: '预览 budget.pdf' }).click();
      await expect(page.getByRole('dialog').locator('pre')).toContainText('[第 2 页]');
      expect(await page.evaluate(() => 'pdfExecuted' in window)).toBe(false);
      await page.getByRole('button', { name: '关闭文件预览' }).click();
      const acceptance = page.waitForResponse(
        (response) =>
          response.url().endsWith(`/conversations/${fixture.id}/messages`) &&
          response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: '发送消息' }).click();
      const response = await acceptance;
      expect(response.status()).toBe(202);
      const result = (await response.json()) as Submission;
      const file = messageFiles(
        (await fixture.snapshot()).messages.find((message) => message.id === result.userId)!,
      )[0];
      expect(file.mediaType).toBe('application/pdf');
      expect(file.pdf).toEqual({ pages: 2, parserVersion: PDF_PARSER_VERSION });
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(JSON.stringify(await fixture.snapshot())).not.toContain('Second page reference');
      await first.close();
      expect(messageText(await finish(fixture, result))).toContain('答案。');
      await second.request.post('/__dev/access/login', { headers });
      const other = await second.newPage();
      await other.goto(`/c/${fixture.id}`);
      await other.getByRole('button', { name: '预览 budget.pdf' }).click();
      await expect(other.getByRole('dialog').locator('pre')).toContainText('Budget: 42');
      await expect(other.getByRole('dialog').locator('pre')).toContainText('Second page reference');
      const parsed = await request.get(docUrl(fixture.id, file.attachmentId));
      expect(parsed.headers()['cache-control']).toBe('no-store');
      expect(
        createHash('sha256')
          .update((await parsed.json()).text)
          .digest('hex'),
      ).toBe(file.textSha256);
      expect(
        Buffer.from(await (await request.get(attachmentUrl(fixture.id, file.attachmentId))).body()),
      ).toEqual(bytes);
    } finally {
      await first.close();
      await second.close();
      await fixture.cleanup();
    }
  });
}
test('PDF extraction supports bundled CMaps and originals larger than the text-file limit', async ({
  page,
  request,
}) => {
  const fixture = await setup(request);
  try {
    await login(page, fixture.id);
    const bytes = textPdf([['预算：42 元。', '保留中文资料。']], {
      unicode: true,
      paddingBytes: 180000,
    });
    expect(bytes.length).toBeGreaterThan(131072);
    await page
      .getByLabel('选择聊天文件')
      .setInputFiles({ name: '中文预算.pdf', mimeType: 'application/pdf', buffer: bytes });
    await page.getByRole('button', { name: '预览 中文预算.pdf' }).click();
    await expect(page.getByRole('dialog').locator('pre')).toContainText('预算：42 元');
    await expect(page.getByRole('dialog').locator('pre')).toContainText('保留中文资料');
    await page.getByRole('button', { name: '关闭文件预览' }).click();
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByTestId('assistant-message')).toContainText('答案。');
  } finally {
    await fixture.cleanup();
  }
});
test('malformed, textless, oversized-page and oversized-text PDFs preserve the draft and make no task or upload', async ({
  page,
  request,
}) => {
  const fixture = await setup(request);
  try {
    await login(page, fixture.id);
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await editor.fill('保留草稿');
    for (const [bytes, error] of [
      [textPdf(undefined, { malformed: true }), '无法读取'],
      [textPdf(undefined, { blank: true }), '没有可提取'],
      [textPdf(Array.from({ length: 51 }, () => ['page'])), '50 页'],
      [textPdf([['a'.repeat(65000)]], { fontSize: 0.01 }), '64,000'],
      [readFileSync(new URL('../../support/assets/password.pdf', import.meta.url)), '口令'],
    ] as const) {
      await page
        .getByLabel('选择聊天文件')
        .setInputFiles({ name: 'rejected.pdf', mimeType: 'application/pdf', buffer: bytes });
      await expect(page.getByRole('alert')).toContainText(error);
      await expect(editor).toHaveValue('保留草稿');
      expect((await fixture.snapshot()).messages).toHaveLength(0);
      expect(
        await (await request.get(`/api/conversations/${fixture.id}/attachments`)).json(),
      ).toEqual([]);
    }
  } finally {
    await fixture.cleanup();
  }
});
test('server binds extracted text to immutable PDF source and rejects missing, changed, foreign and invalid extraction data before tasks', async ({
  request,
}) => {
  const fixture = await setup(request),
    other = await setup(request),
    file = await upload(request, fixture.id);
  const extraction: PDFExtraction = {
    sourceSha256: file.sha256,
    text: '[第 1 页]\nBudget: 42.',
    pdf: { pages: 1, parserVersion: PDF_PARSER_VERSION },
  };
  try {
    expect((await request.post(docUrl(fixture.id, file.id), { headers })).status()).toBe(400);
    for (const patch of [
      { sourceSha256: 'a'.repeat(64) },
      { text: '  ' },
      { text: 'text\u0000' },
      { text: 'x'.repeat(64001) },
      { pdf: { pages: 51, parserVersion: PDF_PARSER_VERSION } },
    ])
      expect(
        (
          await request.post(docUrl(fixture.id, file.id), {
            headers,
            data: { ...extraction, ...patch },
          })
        ).status(),
      ).toBeGreaterThanOrEqual(400);
    expect(
      (await request.post(docUrl(other.id, file.id), { headers, data: extraction })).status(),
    ).toBe(404);
    const saved = await request.post(docUrl(fixture.id, file.id), { headers, data: extraction });
    expect(saved.status()).toBe(200);
    const part = await saved.json();
    expect(
      await (await request.post(docUrl(fixture.id, file.id), { headers, data: extraction })).json(),
    ).toEqual(part);
    expect(
      (
        await request.post(docUrl(fixture.id, file.id), {
          headers,
          data: { ...extraction, text: 'Budget: 99.' },
        })
      ).status(),
    ).toBe(409);
    expect((await fixture.snapshot()).messages).toHaveLength(0);
    expect(
      (
        await request.delete(`/api/conversations/${fixture.id}/attachments/${file.id}`, { headers })
      ).status(),
    ).toBe(200);
    await expect
      .poll(async () =>
        (await control(request)).objects.some((object: { key: string }) =>
          object.key.includes(`/${file.id}/`),
        ),
      )
      .toBe(false);
    expect(
      (await control(request)).pdfMetadataIds.some((row: { id: string }) => row.id === file.id),
    ).toBe(false);
  } finally {
    await fixture.cleanup();
    await other.cleanup();
  }
});
for (const stage of ['module', 'worker'] as const)
  test(`stalled PDF ${stage} loading times out and preserves the draft without registering or sending`, async ({
    page,
    request,
  }) => {
    const fixture = await setup(request);
    let release!: () => void;
    try {
      await login(page, fixture.id);
      await page.clock.install();
      let waiting = false;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        stage === 'module' ? '**/src/features/attachments/chat-pdf.ts*' : '**/pdf.worker.min.mjs*',
        async (route) => {
          if (stage === 'worker' && new URL(route.request().url()).searchParams.has('url'))
            return route.continue();
          waiting = true;
          await wait;
          await route.continue().catch(() => {});
        },
      );
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('超时仍保留');
      await page
        .getByLabel('选择聊天文件')
        .setInputFiles({ name: 'slow.pdf', mimeType: 'application/pdf', buffer: textPdf() });
      await expect.poll(() => waiting).toBe(true);
      await page.clock.fastForward(31000);
      await expect(page.getByRole('alert')).toContainText('30 秒');
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
        '超时仍保留',
      );
      expect(
        await (await request.get(`/api/conversations/${fixture.id}/attachments`)).json(),
      ).toEqual([]);
      expect((await fixture.snapshot()).messages).toHaveLength(0);
    } finally {
      release?.();
      await fixture.cleanup();
    }
  });
test('an unknown PDF extraction write recovers its lease and metadata before an explicit retry', async ({
  request,
}) => {
  const fixture = await setup(request),
    file = await upload(request, fixture.id);
  const extraction: PDFExtraction = {
    sourceSha256: file.sha256,
    text: '[第 1 页]\nBudget: 42.',
    pdf: { pages: 1, parserVersion: PDF_PARSER_VERSION },
  };
  try {
    await control(request, { reset: true });
    expect([500, 503]).toContain(
      (await request.post(docUrl(fixture.id, file.id), { headers, data: extraction })).status(),
    );
    const before = await control(request);
    expect(before.documents.find((row: { id: string }) => row.id === file.id)?.status).toBe(
      'parsing',
    );
    expect(before.pdfMetadataIds.some((row: { id: string }) => row.id === file.id)).toBe(true);
    await control(request, { id: file.id, expire: true });
    await expect
      .poll(async () =>
        (await control(request)).pdfMetadataIds.some((row: { id: string }) => row.id === file.id),
      )
      .toBe(false);
    expect((await request.get(attachmentUrl(fixture.id, file.id))).status()).toBe(200);
    expect(
      (await request.post(docUrl(fixture.id, file.id), { headers, data: extraction })).status(),
    ).toBe(200);
    expect((await fixture.snapshot()).messages).toHaveLength(0);
  } finally {
    await control(request, { reset: false });
    await fixture.cleanup();
  }
});
test('cancelling a cold PDF module load releases the composer and keeps the destination draft clean', async ({
  page,
  request,
}) => {
  const fixture = await setup(request),
    other = await setup(request);
  let release!: () => void;
  try {
    await login(page, fixture.id);
    let waiting = false;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/src/features/attachments/chat-pdf.ts*', async (route) => {
      waiting = true;
      await wait;
      await route.continue().catch(() => {});
    });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('来源草稿');
    await page
      .getByLabel('选择聊天文件')
      .setInputFiles({ name: 'cancel.pdf', mimeType: 'application/pdf', buffer: textPdf() });
    await expect.poll(() => waiting).toBe(true);
    await page.evaluate((id) => {
      history.pushState(null, '', `/c/${id}`);
      dispatchEvent(new PopStateEvent('popstate'));
    }, other.id);
    await expect(page.getByRole('button', { name: '添加附件', exact: true })).toBeEnabled();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
    release();
    expect(
      await (await request.get(`/api/conversations/${fixture.id}/attachments`)).json(),
    ).toEqual([]);
  } finally {
    release?.();
    await fixture.cleanup();
    await other.cleanup();
  }
});
