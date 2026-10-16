import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { attachmentUrl } from '../../../shared/attachments/files';
import { PDF_PARSER_VERSION } from '../../../shared/attachments/pdf';
import { messageAttachments, messageFiles } from '../../../shared/conversation/content';
import type { Submission } from '../../../shared/conversation/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { textPdf } from '../../support/assets/pdf';

const headers = { Origin: 'http://127.0.0.1:5174' };
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const control = (request: APIRequestContext, data: object = {}) =>
  request
    .post('/api/__test/library/attachments', { headers, data })
    .then((response) => response.json());
const snapshot = (request: APIRequestContext, id: string) =>
  request.get(`/api/conversations/${id}`).then((response) => response.json()) as Promise<Snapshot>;
async function setup(request: APIRequestContext) {
  await request.post('/api/login', { headers, data: { password: 'everchat-local' } });
  await control(request, { count: 0 });
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    copies: string[] = [];
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: 'Copy fixture',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: 'benchmark-text-2-10-32',
                  name: '附件复制模型',
                  enabled: true,
                  metadataOverrides: { imageInput: true, contextWindow: 200000 },
                },
              ],
            },
          ],
          activeProviderId: providerId,
          activeModel: 'benchmark-text-2-10-32',
          systemPrompt: '',
          maxOutputTokens: null,
        },
      })
    ).ok(),
  ).toBe(true);
  await request.post('/api/conversations', { headers, data: { id, title: '附件复制源' } });
  return {
    id,
    copies,
    cleanup: async () => {
      await control(request, { releaseText: true, reset: false });
      for (const cid of [id, ...copies])
        await request.delete(`/api/conversations/${cid}`, { headers });
    },
  };
}
async function upload(
  request: APIRequestContext,
  id: string,
  name = 'budget.txt',
  bytes = Buffer.from('Budget: 42.'),
  mediaType = 'text/plain',
  parse = true,
) {
  const input = {
    id: crypto.randomUUID(),
    name,
    size: bytes.length,
    mediaType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  expect(
    (await request.post(`/api/conversations/${id}/attachments`, { headers, data: input })).status(),
  ).toBe(201);
  expect((await request.put(attachmentUrl(id, input.id), { headers, data: bytes })).status()).toBe(
    200,
  );
  if (parse)
    expect(
      (
        await request.post(`/api/conversations/${id}/attachments/${input.id}/document`, {
          headers,
          ...(mediaType === 'application/pdf'
            ? {
                data: {
                  sourceSha256: input.sha256,
                  text: '[第 1 页]\nPDF budget: 42.',
                  pdf: { pages: 1, parserVersion: PDF_PARSER_VERSION },
                },
              }
            : {}),
        })
      ).status(),
    ).toBe(200);
  return { ...input, bytes };
}
async function send(request: APIRequestContext, id: string, input: object = {}) {
  const parentId =
    [...(await snapshot(request, id)).messages]
      .reverse()
      .find((message) => message.status === 'completed' && !message.deletedAt && !message.summary)
      ?.id ?? null;
  const response = await request.post(`/api/conversations/${id}/messages`, {
    headers,
    data: { parentId, requestId: crypto.randomUUID(), content: '附件资料', ...input },
  });
  expect(response.status()).toBe(202);
  const submission = (await response.json()) as Submission;
  await expect
    .poll(
      async () =>
        (await snapshot(request, id)).messages.find(
          (message) => message.id === submission.assistantId,
        )?.status,
    )
    .toBe('completed');
  return submission;
}
const duplicate = (request: APIRequestContext, id: string, requestId: string, messageId?: string) =>
  request.post(`/api/conversations/${id}${messageId ? `/messages/${messageId}` : ''}/duplicate`, {
    headers,
    data: { requestId },
  });

test('a full copy owns independent image, CSV, PDF and unused raw files after source deletion, with private cross-device previews and usable chat references', async ({
  request,
  browser,
}) => {
  const fixture = await setup(request),
    copyId = crypto.randomUUID();
  fixture.copies.push(copyId);
  try {
    const image = await upload(request, fixture.id, 'pixel.png', png, 'image/png', false);
    const csv = await upload(
      request,
      fixture.id,
      'budget.csv',
      Buffer.from('item,cost\nbook,42\n'),
      'text/csv',
    );
    const pdf = await upload(request, fixture.id, 'budget.pdf', textPdf(), 'application/pdf');
    const unused = await upload(
      request,
      fixture.id,
      'unused.txt',
      Buffer.from('unreferenced raw file'),
      'text/plain',
      false,
    );
    await send(request, fixture.id, { imageIds: [image.id], fileIds: [csv.id, pdf.id] });
    const source = await snapshot(request, fixture.id),
      response = await duplicate(request, fixture.id, copyId);
    expect(response.status()).toBe(201);
    const copy = (await response.json()) as { id: string; snapshot: Snapshot };
    expect(copy.id).toBe(copyId);
    expect(copy.snapshot.messages.map((message) => message.id)).not.toEqual(
      source.messages.map((message) => message.id),
    );
    const references = messageAttachments(copy.snapshot.messages[0]);
    expect(references).toHaveLength(3);
    expect(references.map((part) => part.attachmentId)).not.toEqual(
      messageAttachments(source.messages[0]).map((part) => part.attachmentId),
    );
    const files = (await request
      .get(`/api/conversations/${copyId}/attachments`)
      .then((result) => result.json())) as { id: string; name: string }[];
    expect(files).toHaveLength(4);
    expect((await request.delete(`/api/conversations/${fixture.id}`, { headers })).status()).toBe(
      200,
    );
    for (const original of [image, csv, pdf, unused]) {
      const copied = files.find((file) => file.name === original.name)!;
      expect(copied.id).not.toBe(original.id);
      expect(await (await request.get(attachmentUrl(copyId, copied.id))).body()).toEqual(
        original.bytes,
      );
    }
    const device = await browser.newContext();
    try {
      await device.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
      const page = await device.newPage();
      await page.goto(`/c/${copyId}`);
      await page.getByRole('button', { name: '预览 budget.pdf' }).click();
      await expect(page.getByRole('dialog').locator('pre')).toContainText('PDF budget: 42');
      await page.getByRole('button', { name: '关闭文件预览' }).click();
      await page.getByRole('button', { name: '预览 budget.csv' }).click();
      await expect(page.getByRole('dialog').locator('pre')).toContainText('book,42');
    } finally {
      await device.close();
    }
    expect((await duplicate(request, fixture.id, copyId)).status()).toBe(201);
    await send(request, copyId, { content: '继续使用副本资料' });
    const file = messageFiles(copy.snapshot.messages[0])[0];
    expect(
      (
        await request.delete(`/api/conversations/${copyId}/attachments/${file.attachmentId}`, {
          headers,
        })
      ).status(),
    ).toBe(409);
  } finally {
    await fixture.cleanup();
  }
});

test('copying a selected path copies only that path attachments and preserves deletion independence', async ({
  request,
}) => {
  const fixture = await setup(request),
    copyId = crypto.randomUUID();
  fixture.copies.push(copyId);
  try {
    const early = await upload(request, fixture.id),
      first = await send(request, fixture.id, { fileIds: [early.id] });
    const later = await upload(request, fixture.id, 'later.txt', Buffer.from('later branch'));
    await send(request, fixture.id, { fileIds: [later.id] });
    await upload(request, fixture.id, 'unused.txt', Buffer.from('unused'), 'text/plain', false);
    const response = await duplicate(request, fixture.id, copyId, first.assistantId);
    expect(response.status()).toBe(201);
    const copy = (await response.json()) as { snapshot: Snapshot };
    expect(copy.snapshot.messages).toHaveLength(2);
    const files = await request
      .get(`/api/conversations/${copyId}/attachments`)
      .then((result) => result.json());
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe(early.name);
    expect(files[0].id).not.toBe(early.id);
    await request.delete(`/api/conversations/${copyId}`, { headers });
    expect(await (await request.get(attachmentUrl(fixture.id, early.id))).body()).toEqual(
      early.bytes,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('closing the initiating page does not stop a claimed copy; retry after reopening reuses the saved request and performs no extra R2 writes', async ({
  request,
  page,
}) => {
  const fixture = await setup(request);
  let copyId = '';
  try {
    const file = await upload(request, fixture.id);
    await send(request, fixture.id, { fileIds: [file.id] });
    await control(request, { holdTextRead: file.id });
    await page.request.post('/api/login', { headers, data: { password: 'everchat-local' } });
    await page.goto(`/c/${fixture.id}`);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('来源草稿');
    await page.route('**/duplicate', async (route) => {
      copyId = route.request().postDataJSON().requestId;
      fixture.copies.push(copyId);
      await route.continue();
    });
    await page.getByRole('button', { name: '更多会话操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '复制对话', exact: true }).click();
    await expect.poll(async () => (await control(request)).textWaiting).toBe(true);
    expect((await request.get(`/api/conversations/${copyId}`)).status()).toBe(404);
    expect(
      (
        await request.get('/api/conversations').then((response) => response.json())
      ).conversations.some((item: { id: string }) => item.id === copyId),
    ).toBe(false);
    const context = page.context();
    await page.close();
    await control(request, { releaseText: true });
    await expect
      .poll(
        async () =>
          (await control(request)).copies.find((job: { id: string }) => job.id === copyId)?.status,
      )
      .toBe('completed');
    const writes = (await control(request)).dailyCount;
    const reopened = await context.newPage();
    await reopened.goto(`/c/${fixture.id}`);
    await expect(reopened.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
      '来源草稿',
    );
    await reopened.getByRole('button', { name: '更多会话操作', exact: true }).click();
    await reopened.getByRole('menuitem', { name: '复制对话', exact: true }).click();
    await expect(reopened).toHaveURL((url) => url.pathname === `/c/${copyId}`);
    expect((await control(request)).dailyCount).toBe(writes);
  } finally {
    await fixture.cleanup();
  }
});

test('concurrent identical requests share one copy, different sources cannot reuse its ID and the active-copy limit rejects without creating a target', async ({
  request,
}) => {
  const fixture = await setup(request),
    ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  fixture.copies.push(...ids);
  try {
    const file = await upload(request, fixture.id);
    const task = await send(request, fixture.id, { fileIds: [file.id] });
    await control(request, { holdTextRead: file.id });
    const first = duplicate(request, fixture.id, ids[0]);
    const second = duplicate(request, fixture.id, ids[1]);
    await expect
      .poll(
        async () =>
          (await control(request)).copies.filter(
            (job: { status: string }) => job.status === 'copying',
          ).length,
      )
      .toBe(2);
    const same = duplicate(request, fixture.id, ids[0]);
    expect((await duplicate(request, fixture.id, ids[0], task.userId)).status()).toBe(409);
    expect((await duplicate(request, fixture.id, ids[2])).status()).toBe(429);
    expect((await request.get(`/api/conversations/${ids[2]}`)).status()).toBe(404);
    await control(request, { releaseText: true });
    const responses = await Promise.all([first, second, same]);
    expect(responses.map((response) => response.status())).toEqual([201, 201, 201]);
    expect((await responses[0].json()).id).toBe((await responses[2].json()).id);
    expect((await control(request)).dailyCount).toBe(3);
  } finally {
    await fixture.cleanup();
  }
});

test('an instance reset after the raw R2 write stops the copy and durably cleans all staged files before a new explicit attempt', async ({
  request,
}) => {
  const fixture = await setup(request),
    failedId = crypto.randomUUID(),
    nextId = crypto.randomUUID();
  fixture.copies.push(failedId, nextId);
  try {
    const file = await upload(request, fixture.id);
    await send(request, fixture.id, { fileIds: [file.id] });
    await control(request, { reset: true });
    expect([500, 503]).toContain((await duplicate(request, fixture.id, failedId)).status());
    await expect
      .poll(
        async () =>
          (await control(request)).copies.find((job: { id: string }) => job.id === failedId)
            ?.status,
      )
      .toBe('failed');
    const staged = (await control(request)).rows.filter(
      (row: { conversationId: string }) => row.conversationId === failedId,
    );
    for (const row of staged) await control(request, { id: row.id, expire: true });
    await expect
      .poll(async () =>
        (await control(request)).objects.some((object: { key: string }) =>
          object.key.includes(`/${failedId}/`),
        ),
      )
      .toBe(false);
    expect((await duplicate(request, fixture.id, failedId)).status()).toBe(409);
    expect(await (await request.get(attachmentUrl(fixture.id, file.id))).body()).toEqual(
      file.bytes,
    );
    const response = await duplicate(request, fixture.id, nextId);
    expect(response.status()).toBe(201);
    expect(messageFiles((await response.json()).snapshot.messages[0])[0].attachmentId).not.toBe(
      file.id,
    );
  } finally {
    await fixture.cleanup();
  }
});

for (const failure of ['deadline', 'source-deletion'] as const)
  test(`${failure} stops a paused copy without publishing or starting another write`, async ({
    request,
  }) => {
    const fixture = await setup(request),
      copyId = crypto.randomUUID();
    fixture.copies.push(copyId);
    try {
      const file = await upload(request, fixture.id);
      await send(request, fixture.id, { fileIds: [file.id] });
      await control(request, { holdTextRead: file.id });
      const copying = duplicate(request, fixture.id, copyId);
      await expect.poll(async () => (await control(request)).textWaiting).toBe(true);
      if (failure === 'deadline') await control(request, { expireCopy: copyId });
      else await request.delete(`/api/conversations/${fixture.id}`, { headers });
      await expect
        .poll(
          async () =>
            (await control(request)).copies.find((job: { id: string }) => job.id === copyId)
              ?.status,
        )
        .toBe('failed');
      await control(request, { releaseText: true });
      expect((await copying).status()).toBe(failure === 'deadline' ? 408 : 410);
      expect((await control(request)).dailyCount).toBe(1);
      expect(
        (
          await request.get('/api/conversations').then((response) => response.json())
        ).conversations.some((item: { id: string }) => item.id === copyId),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

test('histories larger than the RPC object limit copy through native streams with complete text and independent message IDs', async ({
  request,
}) => {
  const fixture = await setup(request),
    copyId = crypto.randomUUID();
  fixture.copies.push(copyId);
  try {
    await request.post(`/api/__test/conversations/${fixture.id}/history`, {
      headers,
      data: { pairs: 16 },
    });
    const original = await snapshot(request, fixture.id),
      response = await duplicate(request, fixture.id, copyId);
    expect(response.status()).toBe(201);
    expect((await response.body()).byteLength).toBeGreaterThan(7800000);
    const copy = (await response.json()).snapshot as Snapshot;
    expect(copy.messages.map((message) => message.parts)).toEqual(
      original.messages.map((message) => message.parts),
    );
    expect(copy.messages.map((message) => message.id)).not.toEqual(
      original.messages.map((message) => message.id),
    );
  } finally {
    await fixture.cleanup();
  }
});
