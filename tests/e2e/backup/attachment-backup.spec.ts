import { directUpload } from '../../support/browser/attachments';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { attachmentUrl } from '../../../shared/attachments/files';
import { PDF_PARSER_VERSION } from '../../../shared/attachments/pdf';
import { extractedPath, originalPath, type ArchiveManifest } from '../../../shared/backup/archive';
import { decodeArchive } from '../../../shared/backup/codec';
import { messageAttachments } from '../../../shared/conversation/content';
import type { Submission } from '../../../shared/conversation/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { textPdf } from '../../support/assets/pdf';

const headers = { Origin: 'http://127.0.0.1:5174' },
  origin = headers.Origin;
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
const manifest = (request: APIRequestContext, id: string) =>
  request
    .get(`/api/conversations/${id}/backup/manifest`)
    .then((response) => response.json()) as Promise<ArchiveManifest>;
async function setup(request: APIRequestContext) {
  await request.post('/__dev/access/login', { headers });
  await control(request, { count: 0 });
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID(),
    restored: string[] = [];
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: 'Archive fixture',
              provider: 'openai-chat',
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: 'benchmark-text-2-10-32',
                  name: '存档模型',
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
  await request.post('/api/conversations', { headers, data: { id, title: '附件备份源' } });
  return {
    id,
    restored,
    selection: { providerId, model: 'benchmark-text-2-10-32' },
    cleanup: async () => {
      await control(request, { releaseText: true, reset: false });
      for (const cid of restored) await request.delete(`/api/backup/imports/${cid}`, { headers });
      for (const cid of [id, ...restored])
        await request.delete(`/api/conversations/${cid}`, { headers });
      await expect
        .poll(
          async () =>
            (await control(request)).imports.filter(
              (job: { id: string; removed: number }) => restored.includes(job.id) && !job.removed,
            ).length,
        )
        .toBe(0);
    },
  };
}
async function upload(
  request: APIRequestContext,
  cid: string,
  name = 'budget.txt',
  bytes = Buffer.from('Budget: 42.'),
  mediaType = 'text/plain',
  parse = true,
) {
  const file = {
    id: crypto.randomUUID(),
    name,
    size: bytes.length,
    mediaType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  expect(
    (
      await request.post(`/api/conversations/${cid}/attachments/uploads`, { headers, data: [file] })
    ).status(),
  ).toBe(201);
  expect((await directUpload(request, cid, file.id, bytes)).status()).toBe(200);
  if (parse)
    expect(
      (
        await request.post(`/api/conversations/${cid}/attachments/${file.id}/document`, {
          headers,
          ...(mediaType === 'application/pdf'
            ? {
                data: {
                  sourceSha256: file.sha256,
                  text: '[第 1 页]\nPDF budget: 42.',
                  pdf: { pages: 1, parserVersion: PDF_PARSER_VERSION },
                },
              }
            : {}),
        })
      ).status(),
    ).toBe(200);
  return file;
}
async function send(request: APIRequestContext, id: string, input: object = {}) {
  const parentId =
    [...(await snapshot(request, id)).messages]
      .reverse()
      .find((message) => message.status === 'completed' && !message.deletedAt && !message.summary)
      ?.id ?? null;
  const response = await request.post(`/api/conversations/${id}/messages`, {
    headers,
    data: { parentId, requestId: crypto.randomUUID(), content: '资料', ...input },
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
async function bytesFor(request: APIRequestContext, saved: ArchiveManifest) {
  const entries: Record<string, Buffer> = {};
  for (const file of saved.files) {
    entries[originalPath(file.id)] = await (
      await request.get(attachmentUrl(saved.backup.conversation.id, file.id))
    ).body();
    if (file.parsed)
      entries[extractedPath(file.id)] = Buffer.from(
        (
          await (
            await request.get(
              `/api/conversations/${saved.backup.conversation.id}/attachments/${file.id}/document`,
            )
          ).json()
        ).text,
      );
  }
  return entries;
}
async function begin(request: APIRequestContext, id: string, saved: ArchiveManifest) {
  const response = await request.post(`/api/backup/imports/${id}`, { headers, data: saved });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<{
    id: string;
    status: string;
    files: { sourceId: string; id: string }[];
  }>;
}
async function putFiles(
  request: APIRequestContext,
  id: string,
  saved: ArchiveManifest,
  entries: Record<string, Uint8Array>,
) {
  for (const file of saved.files)
    for (const [kind, path] of [
      ['content', originalPath(file.id)],
      ['text', file.parsed ? extractedPath(file.id) : undefined],
    ] as const)
      if (path) {
        const response = await request.put(`/api/backup/imports/${id}/files/${file.id}/${kind}`, {
          headers,
          data: Buffer.from(entries[path]),
        });
        expect(response.status(), await response.text()).toBe(200);
      }
}
test('native manifest and staged restore preserve mixed files independently, publish once and never include provider keys', async ({
  request,
}) => {
  const fixture = await setup(request),
    id = crypto.randomUUID();
  fixture.restored.push(id);
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
    await upload(request, fixture.id, 'unused.txt', Buffer.from('unused raw'), 'text/plain', false);
    await send(request, fixture.id, { imageIds: [image.id], fileIds: [csv.id, pdf.id] });
    const saved = await manifest(request, fixture.id),
      entries = await bytesFor(request, saved),
      started = await begin(request, id, saved);
    expect(JSON.stringify(saved)).not.toContain('integration-test-key');
    expect(saved.files).toHaveLength(4);
    expect((await request.get(`/api/conversations/${id}`)).status()).toBe(404);
    expect(
      (
        await request.get('/api/conversations').then((response) => response.json())
      ).conversations.some((item: { id: string }) => item.id === id),
    ).toBe(false);
    expect((await request.post(`/api/backup/imports/${id}/complete`, { headers })).status()).toBe(
      409,
    );
    await putFiles(request, id, saved, entries);
    const completed = await request.post(`/api/backup/imports/${id}/complete`, { headers });
    expect(completed.status(), await completed.text()).toBe(201);
    const result = (await completed.json()) as { id: string; snapshot: Snapshot };
    expect(result.id).toBe(id);
    expect(result.snapshot.messages).toHaveLength(saved.backup.conversation.messages.length);
    expect(result.snapshot.messages.map((message) => message.id)).not.toEqual(
      saved.backup.conversation.messages.map((message) => message.id),
    );
    for (const part of result.snapshot.messages.flatMap(messageAttachments))
      expect(started.files.find((file) => file.id === part.attachmentId)).toBeTruthy();
    await request.delete(`/api/conversations/${fixture.id}`, { headers });
    for (const file of saved.files) {
      const target = started.files.find((item) => item.sourceId === file.id)!.id;
      expect(await (await request.get(attachmentUrl(id, target))).body()).toEqual(
        entries[originalPath(file.id)],
      );
      if (file.parsed)
        expect(
          (
            await (
              await request.get(`/api/conversations/${id}/attachments/${target}/document`)
            ).json()
          ).text,
        ).toBe(entries[extractedPath(file.id)].toString());
    }
    const writes = (await control(request)).dailyCount;
    expect((await begin(request, id, saved)).status).toBe('completed');
    expect((await request.post(`/api/backup/imports/${id}/complete`, { headers })).status()).toBe(
      201,
    );
    expect((await control(request)).dailyCount).toBe(writes);
    await send(request, id, { selection: fixture.selection, content: '继续查看资料' });
    await request.delete(`/api/conversations/${id}`, { headers });
    expect(
      (await request.post(`/api/backup/imports/${id}`, { headers, data: saved })).status(),
    ).toBe(410);
  } finally {
    await fixture.cleanup();
  }
});
test('the real browser ZIP survives source deletion and restores private previews and original bytes on another device', async ({
  request,
  page,
  browser,
}) => {
  const fixture = await setup(request);
  let imported = '';
  const device = await browser.newContext({ locale: 'zh-CN', baseURL: origin });
  try {
    const csv = await upload(
      request,
      fixture.id,
      'budget.csv',
      Buffer.from('item,cost\nbook,42\n'),
      'text/csv',
    );
    const pdf = await upload(request, fixture.id, 'budget.pdf', textPdf(), 'application/pdf');
    await upload(request, fixture.id, 'unused.txt', Buffer.from('unused raw'), 'text/plain', false);
    await send(request, fixture.id, { fileIds: [csv.id, pdf.id] });
    await page.goto(`/c/${fixture.id}`);
    await page.request.post('/__dev/access/login');
    await page.reload();
    await expect(page.getByTestId('assistant-message')).toHaveCount(1);
    await page.getByRole('button', { name: '更多会话操作' }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: '下载备份', exact: true }).click();
    const download = await pending,
      bytes = await readFile((await download.path())!);
    expect(download.suggestedFilename()).toMatch(/\.everchat\.zip$/);
    const decoded = await decodeArchive(bytes);
    expect(decoded.manifest.files).toHaveLength(3);
    expect(bytes.toString()).not.toContain('integration-test-key');
    await request.delete(`/api/conversations/${fixture.id}`, { headers });
    await device.request.post('/__dev/access/login', { headers });
    const other = await device.newPage();
    await other.goto('/');
    await expect(other.getByRole('button', { name: '更多会话操作' })).toBeVisible();
    await other
      .getByRole('banner')
      .locator('input[type="file"]')
      .setInputFiles({ name: 'saved.everchat.zip', mimeType: 'application/zip', buffer: bytes });
    await expect(other).toHaveURL(/\/c\/[0-9a-f-]{36}(?:\?branch=[^#]+)?$/);
    imported = new URL(other.url()).pathname.split('/').at(-1)!;
    fixture.restored.push(imported);
    await expect(other.getByTestId('assistant-message')).toHaveCount(1);
    await other.getByRole('button', { name: '预览 budget.pdf' }).click();
    await expect(other.getByRole('dialog').locator('pre')).toContainText('PDF budget: 42');
    await other.getByRole('button', { name: '关闭文件预览' }).click();
    await expect(other.getByRole('button', { name: '预览 budget.pdf' })).toBeFocused();
    const files = await device.request
      .get(`/api/conversations/${imported}/attachments`)
      .then((response) => response.json());
    expect(files).toHaveLength(3);
    for (const file of decoded.manifest.files)
      expect(
        await (
          await device.request.get(
            attachmentUrl(
              imported,
              files.find((item: { name: string }) => item.name === file.name).id,
            ),
          )
        ).body(),
      ).toEqual(Buffer.from(decoded.entries[originalPath(file.id)]));
  } finally {
    await device.close();
    await fixture.cleanup();
  }
});
test('malformed manifests, missing references and wrong content never publish or change global settings; cancellation cleans staging', async ({
  request,
}) => {
  const fixture = await setup(request),
    id = crypto.randomUUID();
  fixture.restored.push(id);
  try {
    const file = await upload(request, fixture.id);
    await send(request, fixture.id, { fileIds: [file.id] });
    const saved = await manifest(request, fixture.id),
      settings = await request.get('/api/settings/providers').then((response) => response.json());
    const invalid = { ...saved, files: [] };
    expect(
      (await request.post(`/api/backup/imports/${id}`, { headers, data: invalid })).status(),
    ).toBe(400);
    expect((await request.get(`/api/backup/imports/${id}`)).status()).toBe(404);
    await begin(request, id, saved);
    const bad = await request.put(`/api/backup/imports/${id}/files/${file.id}/content`, {
      headers,
      data: Buffer.from('x'.repeat(file.size)),
    });
    expect(bad.status()).toBeGreaterThanOrEqual(400);
    expect((await request.get(`/api/conversations/${id}`)).status()).toBeGreaterThanOrEqual(400);
    expect(
      await request.get('/api/settings/providers').then((response) => response.json()),
    ).toEqual(settings);
    await request.delete(`/api/backup/imports/${id}`, { headers });
    await expect
      .poll(
        async () =>
          (await control(request)).objects.filter((object: { key: string }) =>
            object.key.includes(id),
          ).length,
      )
      .toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test('claimed finalization completes after the initiating page closes and a lost reply reuses the same saved identifier', async ({
  request,
  page,
}) => {
  const fixture = await setup(request);
  let id = '';
  try {
    const file = await upload(request, fixture.id);
    await send(request, fixture.id, { fileIds: [file.id] });
    await page.goto(`/c/${fixture.id}`);
    await page.request.post('/__dev/access/login');
    await page.reload();
    await expect(page.getByTestId('assistant-message')).toHaveCount(1);
    await page.getByRole('button', { name: '更多会话操作' }).click();
    const pending = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: '下载备份', exact: true }).click();
    const zip = await pending,
      bytes = await readFile((await zip.path())!);
    await page.route('**/api/backup/imports/*/complete', async (route) => {
      id = new URL(route.request().url()).pathname.split('/').at(-2)!;
      fixture.restored.push(id);
      const state = await request
        .get(`/api/backup/imports/${id}`)
        .then((response) => response.json());
      await control(request, { holdTextRead: state.files[0].id });
      await route.continue();
    });
    await page
      .getByRole('banner')
      .locator('input[type="file"]')
      .setInputFiles({ name: 'saved.zip', mimeType: 'application/zip', buffer: bytes });
    await expect.poll(async () => Boolean(id) && (await control(request)).textWaiting).toBe(true);
    expect((await request.get(`/api/conversations/${id}`)).status()).toBe(404);
    const writes = (await control(request)).dailyCount;
    await page.close();
    await control(request, { releaseText: true });
    await expect
      .poll(
        async () =>
          (await request.get(`/api/backup/imports/${id}`).then((response) => response.json()))
            .status,
      )
      .toBe('completed');
    const reopened = await page.context().newPage();
    await reopened.goto('/');
    await expect(reopened.getByRole('textbox', { name: '消息' })).toBeVisible();
    await reopened.getByRole('textbox', { name: '消息' }).fill('保留草稿');
    await reopened
      .getByRole('banner')
      .locator('input[type="file"]')
      .setInputFiles({ name: 'saved.zip', mimeType: 'application/zip', buffer: bytes });
    await expect(reopened).toHaveURL((url) => url.pathname === `/c/${id}`);
    expect((await control(request)).dailyCount).toBe(writes);
    await reopened.getByRole('button', { name: '开启新对话', exact: true }).click();
    await expect(reopened.getByRole('textbox', { name: '消息' })).toHaveValue('保留草稿');
  } finally {
    await fixture.cleanup();
  }
});

for (const phase of ['manifest', 'original'] as const)
  test(`reset after ${phase} R2 write fails safely, preserves the source and cleans through a deletion retry`, async ({
    request,
  }) => {
    const fixture = await setup(request),
      id = crypto.randomUUID();
    fixture.restored.push(id);
    try {
      const file = await upload(request, fixture.id),
        saved = await manifest(request, fixture.id),
        entries = await bytesFor(request, saved);
      let target = '';
      if (phase === 'original') target = (await begin(request, id, saved)).files[0].id;
      await control(request, { reset: true });
      const response =
        phase === 'manifest'
          ? await request.post(`/api/backup/imports/${id}`, { headers, data: saved })
          : await request.put(`/api/backup/imports/${id}/files/${file.id}/content`, {
              headers,
              data: entries[originalPath(file.id)],
            });
      expect([500, 503]).toContain(response.status());
      await expect
        .poll(
          async () =>
            (await control(request)).imports.find((job: { id: string }) => job.id === id)?.status,
        )
        .toBe('failed');
      expect((await request.get(`/api/conversations/${id}`)).status()).toBeGreaterThanOrEqual(400);
      expect(await (await request.get(attachmentUrl(fixture.id, file.id))).body()).toEqual(
        entries[originalPath(file.id)],
      );
      await control(request, { failDelete: phase === 'manifest' ? id : target, expireImport: id });
      await expect.poll(async () => (await control(request)).failedDeletes).toBeGreaterThan(0);
      await expect
        .poll(
          async () =>
            (await control(request)).objects.filter((object: { key: string }) =>
              object.key.includes(id),
            ).length,
          { timeout: 40_000 },
        )
        .toBe(0);
      const stopped = await request.post(`/api/backup/imports/${id}`, { headers, data: saved });
      expect(stopped.status()).toBe(409);
      expect((await stopped.json()).code).toBe('import-stopped');
    } finally {
      await fixture.cleanup();
    }
  });

test('concurrent import limits, fixed manifest identity and cancellation retain the original and unchanged settings', async ({
  request,
}) => {
  const fixture = await setup(request),
    ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  fixture.restored.push(...ids);
  try {
    const file = await upload(request, fixture.id),
      saved = await manifest(request, fixture.id),
      settings = await request.get('/api/settings/providers').then((response) => response.json());
    await begin(request, ids[0], saved);
    await begin(request, ids[1], saved);
    expect(
      (await request.post(`/api/backup/imports/${ids[2]}`, { headers, data: saved })).status(),
    ).toBe(429);
    const changed = structuredClone(saved);
    changed.backup.conversation.title = '另一份清单';
    expect(
      (await request.post(`/api/backup/imports/${ids[0]}`, { headers, data: changed })).status(),
    ).toBe(409);
    const writes = (await control(request)).dailyCount;
    await begin(request, ids[0], saved);
    expect((await control(request)).dailyCount).toBe(writes);
    for (const id of ids.slice(0, 2))
      expect((await request.delete(`/api/backup/imports/${id}`, { headers })).status()).toBe(200);
    await expect
      .poll(
        async () =>
          (await control(request)).objects.filter((object: { key: string }) =>
            ids.some((id) => object.key.includes(id)),
          ).length,
      )
      .toBe(0);
    expect(
      await request.get('/api/settings/providers').then((response) => response.json()),
    ).toEqual(settings);
    expect((await request.get(attachmentUrl(fixture.id, file.id))).status()).toBe(200);
  } finally {
    await fixture.cleanup();
  }
});

test('restoring a changed provider endpoint clears its existing key and never calls the new endpoint', async ({
  request,
}) => {
  const fixture = await setup(request),
    id = crypto.randomUUID();
  fixture.restored.push(id);
  try {
    const saved = await manifest(request, fixture.id);
    saved.backup.settings.providers[0].baseUrl = 'https://another-provider.test/v1';
    expect((await begin(request, id, saved)).status).toBe('completed');
    const config = await request.get('/api/settings/providers').then((response) => response.json());
    expect(config.providers[0].apiKey).toBeUndefined();
    expect(config.providers[0].hasApiKey).toBe(false);
    expect(config.activeProviderId).toBeNull();
    expect((await snapshot(request, id)).messages).toHaveLength(0);
  } finally {
    await fixture.cleanup();
  }
});

for (const reason of ['deadline', 'cancellation'] as const)
  test(`${reason} during claimed finalization prevents publication and global configuration changes`, async ({
    request,
  }) => {
    const fixture = await setup(request),
      id = crypto.randomUUID();
    fixture.restored.push(id);
    try {
      const file = await upload(request, fixture.id);
      await send(request, fixture.id, { fileIds: [file.id] });
      const saved = await manifest(request, fixture.id),
        entries = await bytesFor(request, saved),
        state = await begin(request, id, saved);
      await putFiles(request, id, saved, entries);
      const settings = await request
          .get('/api/settings/providers')
          .then((response) => response.json()),
        writes = (await control(request)).dailyCount;
      await control(request, { holdTextRead: state.files[0].id });
      const completing = request.post(`/api/backup/imports/${id}/complete`, { headers });
      await expect.poll(async () => (await control(request)).textWaiting).toBe(true);
      if (reason === 'deadline') await control(request, { expireImport: id });
      else await request.delete(`/api/backup/imports/${id}`, { headers });
      await expect
        .poll(
          async () =>
            (await control(request)).imports.find((job: { id: string }) => job.id === id)?.status,
        )
        .toBe('failed');
      await control(request, { releaseText: true });
      expect((await completing).status()).toBe(reason === 'deadline' ? 408 : 409);
      expect(
        await request.get('/api/settings/providers').then((response) => response.json()),
      ).toEqual(settings);
      expect((await control(request)).dailyCount).toBe(writes);
      expect((await request.get(`/api/conversations/${id}`)).status()).toBeGreaterThanOrEqual(400);
      await expect
        .poll(
          async () =>
            (await control(request)).objects.filter((object: { key: string }) =>
              object.key.includes(id),
            ).length,
        )
        .toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });

test('large histories stream natively through manifest export and restore without truncating messages or exceeding RPC object limits', async ({
  request,
}) => {
  const fixture = await setup(request),
    id = crypto.randomUUID();
  fixture.restored.push(id);
  try {
    await request.post(`/api/__test/conversations/${fixture.id}/history`, {
      headers,
      data: { pairs: 16 },
    });
    const source = await snapshot(request, fixture.id),
      response = await request.get(`/api/conversations/${fixture.id}/backup/manifest`);
    expect(response.status(), await response.text()).toBe(200);
    expect((await response.body()).length).toBeGreaterThan(7800000);
    const saved = (await response.json()) as ArchiveManifest;
    expect((await begin(request, id, saved)).status).toBe('completed');
    const restored = await snapshot(request, id);
    expect(restored.messages.map((message) => message.parts)).toEqual(
      source.messages.map((message) => message.parts),
    );
    expect(restored.messages.map((message) => message.id)).not.toEqual(
      source.messages.map((message) => message.id),
    );
    expect((await request.get(`/api/conversations/${fixture.id}/backup`)).status()).toBe(200);
  } finally {
    await fixture.cleanup();
  }
});

test('large settings remain readable through native responses and oversized provider rows fail before staging', async ({
  request,
}) => {
  const fixture = await setup(request),
    id = crypto.randomUUID(),
    invalid = crypto.randomUUID();
  fixture.restored.push(id);
  try {
    const saved = await manifest(request, fixture.id),
      profile = saved.backup.settings.providers[0];
    const models = Array.from({ length: 200 }, (_, index) => ({
      id: `model-${index}`,
      name: `模型 ${index}`,
      enabled: true,
      useGlobalSystemPrompt: false,
      systemPrompt: 'x'.repeat(7_000),
    }));
    const tooLarge = structuredClone(saved);
    tooLarge.backup.settings.providers[0].models = models.map((model) => ({
      ...model,
      systemPrompt: 'x'.repeat(20_000),
    }));
    expect(
      (await request.post(`/api/backup/imports/${invalid}`, { headers, data: tooLarge })).status(),
    ).toBe(400);
    expect((await request.get(`/api/backup/imports/${invalid}`)).status()).toBe(404);
    saved.backup.settings.providers = Array.from({ length: 4 }, (_, index) => ({
      ...profile,
      id: index ? crypto.randomUUID() : profile.id,
      models,
    }));
    expect(Buffer.byteLength(JSON.stringify(saved))).toBeGreaterThan(5_000_000);
    expect((await begin(request, id, saved)).status).toBe('completed');
    const restored = await request.get('/api/settings/providers');
    expect(restored.status(), await restored.text()).toBe(200);
    const editable = await restored.json();
    expect(editable.providers.map((item: { models: unknown[] }) => item.models)).toEqual(
      saved.backup.settings.providers.map((item) => item.models),
    );
    editable.providers[0].name = '恢复后修改的供应商';
    const updated = await request.put('/api/settings/providers', { headers, data: editable });
    expect(updated.status(), await updated.text()).toBe(200);
    expect((await updated.json()).providers[0].name).toBe('恢复后修改的供应商');
    const session = await request.get('/api/session');
    expect(session.status(), await session.text()).toBe(200);
    const info = await session.json();
    expect(info.models).toHaveLength(200);
    expect(info.models[0].systemPrompt).toHaveLength(7_000);
  } finally {
    // Keep the following tests within the ordinary settings request budget.
    await request.put('/api/settings/providers', {
      headers,
      data: {
        providers: [],
        activeProviderId: null,
        activeModel: '',
        systemPrompt: '',
        maxOutputTokens: null,
      },
    });
    await fixture.cleanup();
  }
});

test('retired daily counters do not prevent registering a backup import', async ({ request }) => {
  const fixture = await setup(request),
    id = crypto.randomUUID();
  fixture.restored.push(id);
  try {
    await upload(request, fixture.id);
    const saved = await manifest(request, fixture.id);
    await control(request, { count: 99 });
    expect(
      (await request.post(`/api/backup/imports/${id}`, { headers, data: saved })).status(),
    ).toBe(200);
    expect((await request.get(`/api/backup/imports/${id}`)).status()).toBe(200);
    const state = await control(request);
    expect(state.dailyCount).toBe(99);
    expect(state.rows.some((file: { conversationId: string }) => file.conversationId === id)).toBe(
      true,
    );
    expect(state.objects.some((file: { key: string }) => file.key.includes(id))).toBe(true);
  } finally {
    await control(request, { count: 0 });
    await fixture.cleanup();
  }
});

test('the browser rejects a damaged archive locally and replaces an identifier after a confirmed initialization failure', async ({
  request,
  page,
}) => {
  const fixture = await setup(request),
    attempted: string[] = [];
  try {
    const saved = await manifest(request, fixture.id);
    await page.goto('/');
    await page.request.post('/__dev/access/login');
    await page.reload();
    const input = page.getByRole('banner').locator('input[type="file"]');
    await page.route('**/api/backup/imports/*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      attempted.push(new URL(route.request().url()).pathname.split('/').at(-1)!);
      if (attempted.length === 1)
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: '目标对话 ID 已被使用。',
            issue: { code: 'CONVERSATION_ID_CONFLICT' },
          }),
        });
      fixture.restored.push(attempted.at(-1)!);
      await route.continue();
    });
    await input.setInputFiles({
      name: 'damaged.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('invalid zip'),
    });
    await expect(page.getByRole('alert')).toContainText('备份存档大小无效');
    expect(attempted).toHaveLength(0);
    const file = {
      name: 'fileless.json',
      mimeType: 'application/json',
      buffer: Buffer.from('\ufeff \n' + JSON.stringify(saved.backup)),
    };
    await input.setInputFiles(file);
    await expect(page.getByRole('alert')).toContainText('目标对话 ID 已被使用');
    expect(attempted).toHaveLength(1);
    await input.setInputFiles(file);
    await expect.poll(() => attempted.length).toBe(2);
    await expect(page).toHaveURL((url) => url.pathname === `/c/${attempted.at(-1)}`);
    expect(attempted).toHaveLength(2);
    expect(attempted[1]).not.toBe(attempted[0]);
  } finally {
    await fixture.cleanup();
  }
});

test('an otherwise empty conversation can back up and restore saved files that have never been sent to a model', async ({
  request,
  page,
}) => {
  const fixture = await setup(request);
  try {
    const file = await upload(
      request,
      fixture.id,
      'unused.txt',
      Buffer.from('saved before chat'),
      'text/plain',
      false,
    );
    await page.goto(`/c/${fixture.id}`);
    await page.request.post('/__dev/access/login');
    await page.reload();
    await expect(page.getByRole('banner').getByText('附件备份源', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '更多会话操作' }).click();
    await expect(page.getByRole('menuitem', { name: '下载备份', exact: true })).toBeEnabled();
    const pending = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: '下载备份', exact: true }).click();
    const downloaded = await pending,
      bytes = await readFile((await downloaded.path())!),
      decoded = await decodeArchive(bytes);
    expect(decoded.manifest.backup.conversation.messages).toEqual([]);
    expect(decoded.manifest.files).toHaveLength(1);
    expect(Buffer.from(decoded.entries[originalPath(file.id)])).toEqual(
      Buffer.from('saved before chat'),
    );
    await request.delete(`/api/conversations/${fixture.id}`, { headers });
    await page.goto('/');
    await page
      .getByRole('banner')
      .locator('input[type="file"]')
      .setInputFiles({ name: 'unused.zip', mimeType: 'application/zip', buffer: bytes });
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}(?:\?branch=[^#]+)?$/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    fixture.restored.push(id);
    const files = await request
      .get(`/api/conversations/${id}/attachments`)
      .then((response) => response.json());
    expect(files).toHaveLength(1);
    expect(await (await request.get(attachmentUrl(id, files[0].id))).body()).toEqual(
      Buffer.from('saved before chat'),
    );
    expect((await snapshot(request, id)).messages).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});

test('an actor without R2 restores a fileless backup while failed file cleanups wait without repeating Alarms', async ({
  request,
}) => {
  const fixture = await setup(request),
    ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  fixture.restored.push(...ids);
  try {
    const empty = await manifest(request, fixture.id);
    await upload(request, fixture.id);
    const withFiles = await manifest(request, fixture.id);
    for (const id of ids.slice(0, 2)) {
      await begin(request, id, withFiles);
      await request.delete(`/api/backup/imports/${id}`, { headers });
    }
    await control(request, { noBucket: true }).catch(() => {});
    expect((await begin(request, ids[2], empty)).status).toBe('completed');
    expect((await request.get(`/api/conversations/${ids[2]}`)).status()).toBe(200);
    await expect.poll(async () => (await control(request)).alarm).toBeNull();
    expect(
      (
        await request.post(`/api/backup/imports/${crypto.randomUUID()}`, {
          headers,
          data: withFiles,
        })
      ).status(),
    ).toBe(503);
    await control(request, { noBucket: false }).catch(() => {});
    await expect
      .poll(
        async () =>
          (await control(request)).objects.filter((file: { key: string }) =>
            ids.some((id) => file.key.includes(id)),
          ).length,
      )
      .toBe(0);
  } finally {
    await control(request, { noBucket: false }).catch(() => {});
    await fixture.cleanup();
  }
});
