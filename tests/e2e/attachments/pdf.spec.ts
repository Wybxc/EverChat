import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeArchive, decodeArchive } from '../../../shared/backup/codec';
import { originalPath, extractedPath, type ArchiveManifest } from '../../../shared/backup/archive';
import { attachmentUrl } from '../../../shared/attachments/files';
import { PDF_PARSER_VERSION, type PDFExtraction } from '../../../shared/attachments/pdf';
import { estimateDocumentTokens } from '../../../shared/attachments/documents';
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
async function setup(
  request: APIRequestContext,
  provider: ProviderKind = 'openai-chat',
  contextWindow = 200000,
) {
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
                  metadataOverrides: { imageInput: false, contextWindow },
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
  await page.request.post('/__dev/access/login', { headers });
  await page.goto(`/c/${id}`);
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
test('complete extraction exceeds the old page and character caps, preserves draft selections and sends only chosen pages', async ({
  page,
  request,
}) => {
  const fixture = await setup(request);
  try {
    await login(page, fixture.id);
    const bytes = textPdf(
      Array.from({ length: 51 }, (_, i) => [i ? `Page ${i + 1}: Budget 42.` : 'a'.repeat(65000)]),
      { fontSize: 0.01 },
    );
    await page
      .getByLabel('选择聊天文件')
      .setInputFiles({ name: 'complete.pdf', mimeType: 'application/pdf', buffer: bytes });
    await page.getByRole('button', { name: '预览 complete.pdf' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('pre')).toContainText('[第 51 页]');
    await dialog.getByLabel('PDF 发送范围').selectOption('pages');
    await dialog.getByLabel('发送页码').fill('2-3,51');
    await expect(dialog.locator('pre')).toContainText('Page 51:');
    await expect(dialog.locator('pre')).not.toContainText('a'.repeat(100));
    await dialog.getByRole('button', { name: '使用选区', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await expect(page.getByTestId('draft-previews')).toContainText('已选片段');
    const accepted = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/conversations/${fixture.id}/messages`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const response = await accepted;
    expect(response.status(), await response.text()).toBe(202);
    const submission = (await response.json()) as Submission;
    await finish(fixture, submission);
    const part = messageFiles(
      (await fixture.snapshot()).messages.find((message) => message.id === submission.userId)!,
    )[0];
    expect(part.pdf?.pages).toBe(51);
    expect(part.characters).toBeLessThan(500);
    expect(part.selection!.sourceCharacters).toBeGreaterThan(65000);
    const full = await request.get(docUrl(fixture.id, part.attachmentId)).then((r) => r.json());
    expect(full.text.length).toBe(part.selection!.sourceCharacters);
    expect(full.pageOffsets).toHaveLength(51);
    expect(JSON.stringify(await fixture.snapshot())).not.toContain('a'.repeat(100));
  } finally {
    await fixture.cleanup();
  }
});

test('native full-text storage and previews exceed RPC object size while excerpt references, copying and backups remain small', async ({
  request,
}) => {
  const fixture = await setup(request),
    file = await upload(request, fixture.id);
  const text = 'Budget: 42.\n' + 'private full document\n'.repeat(65000);
  let copyId: string | undefined, restoredId: string | undefined;
  try {
    const saved = await request.post(docUrl(fixture.id, file.id), {
      headers: { ...headers, 'Content-Type': 'application/vnd.everchat.pdf-text' },
      data:
        JSON.stringify({
          sourceSha256: file.sha256,
          pdf: { pages: 1, parserVersion: PDF_PARSER_VERSION },
          pageOffsets: [0],
        }) +
        '\n' +
        text,
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const original = await saved.json();
    expect(original.characters).toBeGreaterThan(1_048_576);
    expect((await request.get(docUrl(fixture.id, file.id)).then((r) => r.json())).text).toBe(text);
    const ranges = [{ start: 0, end: 11 }];
    const selected = await request.post(docUrl(fixture.id, file.id) + '/selection', {
      headers,
      data: { ranges },
    });
    expect(selected.status()).toBe(200);
    const excerpt = await selected.json();
    expect(excerpt.characters).toBe(11);
    const response = await request.post(`/api/conversations/${fixture.id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        parentId: null,
        fileIds: [file.id],
        fileSelections: { [file.id]: ranges },
      },
    });
    expect(response.status(), await response.text()).toBe(202);
    await finish(fixture, await response.json());
    const copy = await request.post(`/api/conversations/${fixture.id}/duplicate`, {
      headers,
      data: { requestId: crypto.randomUUID() },
    });
    expect(copy.status(), await copy.text()).toBe(201);
    copyId = (await copy.json()).id;
    const copied = (await request
      .get(`/api/conversations/${copyId}`)
      .then((r) => r.json())) as Snapshot;
    expect(messageFiles(copied.messages[0])[0].selection).toEqual(excerpt.selection);
    const manifest = await request
      .get(`/api/conversations/${fixture.id}/backup/manifest`)
      .then((r) => r.json());
    expect(manifest.files[0].parsed.reference.characters).toBe(text.length);
    expect(manifest.files[0].parsed.pageOffsets).toEqual([0]);
    expect(manifest.backup.conversation.messages[0].parts[0].selection).toEqual(excerpt.selection);
    const archived = await encodeArchive(manifest as ArchiveManifest, {
      [originalPath(file.id)]: new Uint8Array(
        await (await request.get(attachmentUrl(fixture.id, file.id))).body(),
      ),
      [extractedPath(file.id)]: Buffer.from(text),
    });
    const decoded = await decodeArchive(archived);
    restoredId = crypto.randomUUID();
    const started = await request.post(`/api/backup/imports/${restoredId}`, {
      headers,
      data: decoded.manifest,
    });
    expect(started.status(), await started.text()).toBe(200);
    const restoredFile = (await started.json()).files[0].id;
    for (const [kind, key] of [
      ['content', originalPath(file.id)],
      ['text', extractedPath(file.id)],
    ]) {
      const uploaded = await request.put(
        `/api/backup/imports/${restoredId}/files/${file.id}/${kind}`,
        { headers, data: Buffer.from(decoded.entries[key]) },
      );
      expect(uploaded.status(), await uploaded.text()).toBe(200);
    }
    const completed = await request.post(`/api/backup/imports/${restoredId}/complete`, { headers });
    expect(completed.status(), await completed.text()).toBe(201);
    const restored = (await request
      .get(`/api/conversations/${restoredId}`)
      .then((r) => r.json())) as Snapshot;
    expect(messageFiles(restored.messages[0])[0].selection).toEqual(excerpt.selection);
    const restoredText = await request.get(docUrl(restoredId, restoredFile)).then((r) => r.json());
    expect(restoredText.text).toBe(text);
    expect(restoredText.pageOffsets).toEqual([0]);
  } finally {
    if (restoredId) await request.delete(`/api/conversations/${restoredId}`, { headers });
    if (copyId) await request.delete(`/api/conversations/${copyId}`, { headers });
    await fixture.cleanup();
  }
});
test('large PDF text uses the real storage allowance and prevents later originals from exceeding the shared conversation quota', async ({
  request,
}) => {
  test.setTimeout(120_000);
  const fixture = await setup(request),
    file = await upload(request, fixture.id);
  const text = 'Budget: 42.\n' + 'a'.repeat(31 * 1024 * 1024 - 12);
  try {
    const saved = await request.post(docUrl(fixture.id, file.id), {
      headers: { ...headers, 'Content-Type': 'application/vnd.everchat.pdf-text' },
      data:
        JSON.stringify({
          sourceSha256: file.sha256,
          pdf: { pages: 1, parserVersion: PDF_PARSER_VERSION },
          pageOffsets: [0],
        }) +
        '\n' +
        text,
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const loaded = await request.get(docUrl(fixture.id, file.id));
    expect(loaded.status(), (await loaded.text()).slice(0, 200)).toBe(200);
    const content = await loaded.json();
    expect(content.text.length).toBe(text.length);
    expect(createHash('sha256').update(content.text).digest('hex')).toBe(
      createHash('sha256').update(text).digest('hex'),
    );
    const selected = await request.post(docUrl(fixture.id, file.id) + '/selection', {
      headers,
      data: { ranges: [{ start: 0, end: 11 }] },
    });
    expect(selected.status(), await selected.text()).toBe(200);
    expect((await selected.json()).characters).toBe(11);
    const tooMuch = await request.post(`/api/conversations/${fixture.id}/attachments`, {
      headers,
      data: { ...file, id: crypto.randomUUID(), size: 2 * 1024 * 1024 },
    });
    expect(tooMuch.status(), await tooMuch.text()).toBe(507);
    expect(
      (await request.get(`/api/conversations/${fixture.id}/attachments`).then((r) => r.json())).map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual([file.id]);
  } finally {
    await fixture.cleanup();
  }
});
test('model capacity guides page selection and an original-text excerpt can be selected on mobile without losing the full PDF', async ({
  page,
  request,
}) => {
  const fixture = await setup(request, 'openai-chat', 4096);
  try {
    await login(page, fixture.id);
    const bytes = textPdf(
      Array.from({ length: 3 }, (_, i) => [`Page ${i + 1}: Budget 42. ` + 'a'.repeat(5000)]),
      { fontSize: 0.01 },
    );
    await page
      .getByLabel('选择聊天文件')
      .setInputFiles({ name: 'capacity.pdf', mimeType: 'application/pdf', buffer: bytes });
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    await expect(send).toBeDisabled();
    await page.getByRole('button', { name: '预览 capacity.pdf' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '按容量选择前几页' }).click();
    await expect(dialog.getByLabel('发送页码')).toHaveValue('1-1');
    await expect(dialog.locator('pre')).toContainText('Page 1:');
    await expect(dialog.locator('pre')).not.toContainText('Page 2:');
    await dialog.getByRole('button', { name: '使用选区', exact: true }).click();
    await expect(send).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '预览 capacity.pdf' }).click();
    await dialog.getByLabel('PDF 发送范围').selectOption('fragment');
    const source = dialog.getByLabel('PDF 原文');
    await source.focus();
    await source.evaluate((node: HTMLTextAreaElement) => {
      const start = node.value.indexOf('Page 2: Budget 42.');
      node.setSelectionRange(start, start + 'Page 2: Budget 42.'.length);
      node.dispatchEvent(new Event('select'));
    });
    const tokens = estimateDocumentTokens(
      { name: 'capacity.pdf', mediaType: 'application/pdf' },
      'Page 2: Budget 42.',
    );
    await expect(dialog.getByRole('status')).toContainText(`当前约 ${tokens.toLocaleString()}`);
    await page.screenshot({ path: '/tmp/everchat-pdf-selection-phone.png' });
    await dialog.getByRole('button', { name: '使用选区', exact: true }).click();
    await page.getByRole('button', { name: '预览 capacity.pdf' }).click();
    await expect(dialog.getByLabel('PDF 原文')).toContainText('Page 3:');
    await dialog.getByRole('button', { name: '关闭文件预览' }).click();
    const acceptance = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/conversations/${fixture.id}/messages`) &&
        response.request().method() === 'POST',
    );
    await send.click();
    const response = await acceptance;
    expect(response.status(), await response.text()).toBe(202);
    const submission = (await response.json()) as Submission;
    await finish(fixture, submission);
    const file = messageFiles(
      (await fixture.snapshot()).messages.find((message) => message.id === submission.userId)!,
    )[0];
    expect(file.characters).toBe('Page 2: Budget 42.'.length);
    expect(file.selection!.sourceCharacters).toBeGreaterThan(15000);
  } finally {
    await fixture.cleanup();
  }
});
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
test('malformed, textless and password-protected PDFs preserve the draft and make no task or upload', async ({
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
    for (const patch of [{ sourceSha256: 'a'.repeat(64) }, { text: '  ' }, { text: 'text\u0000' }])
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
