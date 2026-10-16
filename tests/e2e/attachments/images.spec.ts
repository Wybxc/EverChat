import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { attachmentUrl } from '../../../shared/attachments/files';
import { messageImages, messageText } from '../../../shared/conversation/content';
import type { Submission } from '../../../shared/conversation/types';
import type { ProviderKind } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { chooseChatModel } from '../../support/browser/ui';
const headers = { Origin: 'http://127.0.0.1:5174' },
  providerId = '00000000-0000-4000-8000-000000000088';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
async function setup(request: APIRequestContext, provider: ProviderKind = 'openai-chat') {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: 'Vision fixture',
              provider,
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: `vision-${provider}`,
                  name: '视觉模型',
                  enabled: true,
                  metadataOverrides: { imageInput: true, contextWindow: 200000 },
                },
                {
                  id: 'text-only',
                  name: '文本模型',
                  enabled: true,
                  metadataOverrides: { imageInput: false },
                },
              ],
            },
          ],
          activeProviderId: providerId,
          activeModel: `vision-${provider}`,
          systemPrompt: '',
          maxOutputTokens: null,
        },
      })
    ).ok(),
  ).toBe(true);
  const id = crypto.randomUUID();
  expect(
    (
      await request.post('/api/conversations', { headers, data: { id, title: '图片测试' } })
    ).status(),
  ).toBe(201);
  return {
    id,
    selection: { providerId, model: `vision-${provider}` },
    snapshot: () =>
      request
        .get(`/api/conversations/${id}`)
        .then((response) => response.json()) as Promise<Snapshot>,
    submit: (data: object) => request.post(`/api/conversations/${id}/messages`, { headers, data }),
    cleanup: () => request.delete(`/api/conversations/${id}`, { headers }),
  };
}
async function upload(
  request: APIRequestContext,
  id: string,
  bytes = png,
  name = 'image.png',
  mediaType = 'image/png',
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
  return input;
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
for (const provider of [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
] as ProviderKind[]) {
  test(`${provider}: private persisted image-only task sends native bytes, survives closed pages and is visible on another device`, async ({
    request,
    browser,
  }) => {
    const fixture = await setup(request, provider),
      image = await upload(request, fixture.id);
    const first = await browser.newContext(),
      second = await browser.newContext();
    try {
      await first.request.post('/__dev/access/login', { headers });
      const page = await first.newPage();
      await page.goto(`/c/${fixture.id}`);
      const input = {
        parentId: null,
        requestId: crypto.randomUUID(),
        imageIds: [image.id],
        content: '',
        selection: fixture.selection,
      };
      const submitted = await fixture.submit(input);
      expect(submitted.status()).toBe(202);
      const result = (await submitted.json()) as Submission;
      const accepted = (await fixture.snapshot()).messages.find(
        (message) => message.id === result.userId,
      )!;
      expect(messageImages(accepted)).toEqual([
        {
          type: 'image',
          attachmentId: image.id,
          name: image.name,
          sha256: image.sha256,
          size: image.size,
          mediaType: image.mediaType,
        },
      ]);
      expect(JSON.stringify(await fixture.snapshot())).not.toContain(png.toString('base64'));
      await first.close();
      expect(messageText(await finish(fixture, result))).toContain('答案。');
      expect(await (await fixture.submit(input)).json()).toEqual(result);
      expect((await fixture.snapshot()).messages).toHaveLength(2);
      await second.request.post('/__dev/access/login', { headers });
      const other = await second.newPage();
      await other.goto(`/c/${fixture.id}`);
      await expect(other.getByRole('img', { name: image.name })).toBeVisible();
      expect(
        await other
          .getByRole('img', { name: image.name })
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      ).toBe(1);
      await other.getByRole('button', { name: `预览 ${image.name}` }).click();
      await expect(other.getByRole('dialog')).toBeVisible();
      await other.getByRole('button', { name: '关闭图片预览' }).click();
      expect((await request.get(`/api/conversations/${fixture.id}/backup`)).status()).toBe(409);
      const copy = await request.post(`/api/conversations/${fixture.id}/duplicate`, {
        headers,
        data: { requestId: crypto.randomUUID() },
      });
      expect(copy.status()).toBe(201);
      await request.delete(`/api/conversations/${(await copy.json()).id}`, { headers });
    } finally {
      await first.close();
      await second.close();
      await fixture.cleanup();
    }
  });
}
test('server rejects unsupported, foreign, incomplete, oversized and invalid images before creating messages', async ({
  request,
}) => {
  const fixture = await setup(request),
    other = await setup(request),
    image = await upload(request, fixture.id),
    foreign = await upload(request, other.id);
  const broken = await upload(request, fixture.id, png.subarray(0, 12), 'broken.png');
  const large = Buffer.from(png);
  large.writeUInt32BE(5000, 16);
  const oversized = await upload(request, fixture.id, large, 'large.png');
  const incomplete = {
    id: crypto.randomUUID(),
    name: 'pending.png',
    size: png.length,
    sha256: createHash('sha256').update(png).digest('hex'),
    mediaType: 'image/png',
  };
  await request.post(`/api/conversations/${fixture.id}/attachments`, { headers, data: incomplete });
  try {
    for (const patch of [
      { selection: { providerId, model: 'text-only' }, imageIds: [image.id] },
      { imageIds: [foreign.id] },
      { imageIds: [broken.id] },
      { imageIds: [oversized.id] },
      { imageIds: [incomplete.id] },
      { imageIds: [image.id, image.id] },
    ]) {
      const response = await fixture.submit({
        parentId: null,
        requestId: crypto.randomUUID(),
        content: '',
        selection: fixture.selection,
        ...patch,
      });
      expect(response.status()).toBeGreaterThanOrEqual(400);
      expect((await fixture.snapshot()).messages).toHaveLength(0);
    }
  } finally {
    await fixture.cleanup();
    await other.cleanup();
  }
});
test('image references survive retries and revisions, stay on their branch and protect deletion until every source is removed', async ({
  request,
}) => {
  const fixture = await setup(request),
    image = await upload(request, fixture.id);
  try {
    const first = (await (
      await fixture.submit({
        parentId: null,
        requestId: crypto.randomUUID(),
        content: 'expect-images:1',
        imageIds: [image.id],
        selection: fixture.selection,
      })
    ).json()) as Submission;
    await finish(fixture, first);
    const retried = (await (
      await fixture.submit({
        requestId: crypto.randomUUID(),
        retryOf: first.assistantId,
        selection: fixture.selection,
      })
    ).json()) as Submission;
    await finish(fixture, retried);
    const revised = (await (
      await fixture.submit({
        requestId: crypto.randomUUID(),
        revisionOf: first.userId,
        content: 'expect-images:1',
        imageIds: [image.id],
        selection: fixture.selection,
      })
    ).json()) as Submission;
    await finish(fixture, revised);
    const withoutImage = (await (
      await fixture.submit({
        requestId: crypto.randomUUID(),
        revisionOf: first.userId,
        content: 'expect-images:0',
        selection: fixture.selection,
      })
    ).json()) as Submission;
    await finish(fixture, withoutImage);
    expect(
      messageImages(
        (await fixture.snapshot()).messages.find((message) => message.id === withoutImage.userId)!,
      ),
    ).toEqual([]);
    expect(
      (
        await request.delete(`/api/conversations/${fixture.id}/attachments/${image.id}`, {
          headers,
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await request.delete(`/api/conversations/${fixture.id}/messages/${first.userId}`, {
          headers,
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await request.delete(`/api/conversations/${fixture.id}/attachments/${image.id}`, {
          headers,
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await request.delete(`/api/conversations/${fixture.id}/messages/${revised.userId}`, {
          headers,
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await request.delete(`/api/conversations/${fixture.id}/attachments/${image.id}`, {
          headers,
        })
      ).status(),
    ).toBe(200);
    expect((await request.get(attachmentUrl(fixture.id, image.id))).status()).toBe(404);
    const saved = await fixture.snapshot();
    expect(saved.messages.filter((message) => message.deletedAt).flatMap(messageImages)).toEqual(
      [],
    );
    const unpictured = await fixture.submit({
      requestId: crypto.randomUUID(),
      revisionOf: revised.userId,
      content: 'plain',
      selection: fixture.selection,
    });
    expect(unpictured.status()).toBe(404);
  } finally {
    await fixture.cleanup();
  }
});
async function login(page: Page) {
  await page.goto('/');
  await page.request.post('/__dev/access/login');
  await page.reload();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible();
}
test('new conversation picker scales, previews, persists drafts and sends an image-only message', async ({
  page,
  request,
}) => {
  const fixture = await setup(request);
  await login(page);
  await page.reload();
  const source = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1600;
    canvas.getContext('2d')!.fillRect(0, 0, 2400, 1600);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  let id: string | undefined;
  try {
    await page.getByLabel('消息', { exact: true }).fill('图片草稿');
    await page.getByLabel('选择聊天图片').setInputFiles({
      name: 'large.png',
      mimeType: 'image/png',
      buffer: Buffer.from(source, 'base64'),
    });
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]+(?:\?branch=[^#]+)?$/);
    id = new URL(page.url()).pathname.split('/').at(-1)!;
    await expect(page.getByLabel('待发送图片')).toBeVisible();
    await expect(page.getByLabel('消息', { exact: true })).toBeFocused();
    const stored = await (await request.get(`/api/conversations/${id}/attachments`)).json();
    expect(stored[0].size).toBeLessThanOrEqual(1048576);
    expect(stored[0].mediaType).toBe('image/webp');
    await page.reload();
    await expect(page.getByLabel('待发送图片')).toBeVisible();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('图片草稿');
    await page.getByRole('button', { name: '预览 large.webp' }).click();
    expect(
      await page
        .getByRole('dialog')
        .getByRole('img')
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    ).toBe(1536);
    await page.getByRole('button', { name: '关闭图片预览' }).click();
    await page.getByRole('button', { name: '预览 large.webp' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭图片预览', exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await (await request.get(`/api/conversations/${id}`)).json()).messages).toHaveLength(0);
    await page.getByLabel('消息', { exact: true }).fill('');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByTestId('assistant-message')).toContainText('答案。');
    await expect(page.getByLabel('待发送图片')).toHaveCount(0);
    await expect(page.getByLabel('消息图片')).toBeVisible();
  } finally {
    if (id) await request.delete(`/api/conversations/${id}`, { headers });
    await fixture.cleanup();
  }
});
test('pasted images retain drafts across routes and unsupported model changes preserve the draft', async ({
  page,
  request,
}) => {
  const fixture = await setup(request);
  await login(page);
  await page.goto(`/c/${fixture.id}`);
  try {
    await page.getByLabel('消息', { exact: true }).fill('粘贴图片');
    await page.getByLabel('消息', { exact: true }).evaluate((textarea, encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
        data = new DataTransfer();
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
    }, png.toString('base64'));
    await expect(page.getByLabel('待发送图片')).toBeVisible();
    await chooseChatModel(page, JSON.stringify([providerId, 'text-only']));
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(
      page.getByText('所选模型不支持图片，请选择视觉模型或调整模型能力设置。').first(),
    ).toBeVisible();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('粘贴图片');
    await page.getByRole('button', { name: '开启新对话', exact: true }).click();
    await page.goBack();
    await expect(page.getByLabel('待发送图片')).toBeVisible();
    await page.getByRole('button', { name: '移除 pasted.webp' }).click();
    await expect(page.getByLabel('待发送图片')).toHaveCount(0);
  } finally {
    await fixture.cleanup();
  }
});
test('concurrent file deletion and task acceptance never leave an accepted image reference unreadable', async ({
  request,
}) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const fixture = await setup(request),
      image = await upload(request, fixture.id);
    try {
      const submission = fixture.submit({
        parentId: null,
        requestId: crypto.randomUUID(),
        content: '',
        imageIds: [image.id],
        selection: fixture.selection,
      });
      if (attempt % 2) await new Promise((resolve) => setTimeout(resolve, 20));
      const deletion = request.delete(`/api/conversations/${fixture.id}/attachments/${image.id}`, {
        headers,
      });
      const [accepted, removed] = await Promise.all([submission, deletion]);
      if (accepted.status() === 202) {
        expect(removed.status()).toBe(409);
        expect((await request.get(attachmentUrl(fixture.id, image.id))).status()).toBe(200);
        await finish(fixture, (await accepted.json()) as Submission);
      } else {
        expect(removed.status()).toBe(200);
        expect((await fixture.snapshot()).messages).toHaveLength(0);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});
test('uploaded image-only requests remain in the offline outbox and send once after reconnection', async ({
  page,
  request,
  context,
}) => {
  const fixture = await setup(request);
  await login(page);
  await page.goto(`/c/${fixture.id}`);
  try {
    await page
      .getByLabel('选择聊天图片')
      .setInputFiles({ name: 'offline.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByLabel('待发送图片')).toBeVisible();
    await context.setOffline(true);
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
    expect((await fixture.snapshot()).messages).toHaveLength(0);
    await context.setOffline(false);
    await expect(page.getByTestId('assistant-message')).toContainText('答案。');
    await expect(page.getByText('等待发送', { exact: true })).toHaveCount(0);
    expect((await fixture.snapshot()).messages).toHaveLength(2);
    await expect(page.getByRole('img', { name: 'offline.webp' })).toBeVisible();
  } finally {
    await context.setOffline(false);
    await fixture.cleanup();
  }
});
test('switching conversations cancels an image upload, cleans its registration and leaves the new draft focused', async ({
  page,
  request,
}) => {
  const fixture = await setup(request);
  await login(page);
  await page.goto(`/c/${fixture.id}`);
  let release!: () => void,
    started = false;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/attachments/*/content', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    started = true;
    await wait;
    await route.abort().catch(() => {});
  });
  try {
    await page.getByLabel('消息', { exact: true }).fill('原对话草稿');
    await page
      .getByLabel('选择聊天图片')
      .setInputFiles({ name: 'cancel.png', mimeType: 'image/png', buffer: png });
    await expect.poll(() => started).toBe(true);
    await page.getByRole('button', { name: '开启新对话', exact: true }).click();
    release();
    await expect(page).toHaveURL('/');
    await expect(page.getByLabel('消息', { exact: true })).toBeFocused();
    await page.getByLabel('消息', { exact: true }).fill('新对话草稿');
    await expect(page.getByLabel('图片上传进度')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/conversations/${fixture.id}/attachments`)).json()).length,
      )
      .toBe(0);
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('新对话草稿');
    await page.goBack();
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('原对话草稿');
    await expect(page.getByLabel('待发送图片')).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await fixture.cleanup();
  }
});
test('a remote conversation deletion clears image draft metadata from the current page', async ({
  page,
  request,
}) => {
  const fixture = await setup(request);
  await login(page);
  await page.goto(`/c/${fixture.id}`);
  try {
    await page.getByLabel('消息', { exact: true }).fill('将删除的草稿');
    await page
      .getByLabel('选择聊天图片')
      .setInputFiles({ name: 'private.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByLabel('待发送图片')).toBeVisible();
    expect((await fixture.cleanup()).status()).toBe(200);
    await expect(page.getByLabel('待发送图片')).toHaveCount(0);
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('');
  } finally {
    await fixture.cleanup();
  }
});
