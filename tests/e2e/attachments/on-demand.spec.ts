import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { directUpload } from '../../support/browser/attachments';
import type { ProviderKind } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { messageText } from '../../../shared/conversation/content';

const headers = { Origin: 'http://127.0.0.1:5174' },
  providerId = '00000000-0000-4000-8000-000000000209';
async function setup(request: APIRequestContext, protocol: ProviderKind) {
  await request.post('/__dev/access/login', { headers });
  const model = `tools-attachment-${protocol}`;
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          providers: [
            {
              id: providerId,
              name: 'Attachment fixture',
              provider: protocol,
              baseUrl: 'https://provider.test/v1',
              apiKey: 'integration-test-key',
              models: [
                {
                  id: model,
                  name: model,
                  enabled: true,
                  metadataOverrides: { contextWindow: 200000, toolCalls: true },
                },
              ],
            },
          ],
          activeProviderId: providerId,
          activeModel: model,
          systemPrompt: '',
          maxOutputTokens: null,
        },
      })
    ).ok(),
  ).toBe(true);
  const id = crypto.randomUUID();
  expect(
    (
      await request.post('/api/conversations', { headers, data: { id, title: '按需附件验证' } })
    ).status(),
  ).toBe(201);
  return {
    id,
    model,
    snapshot: () =>
      request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>,
  };
}

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const) {
  test(`${protocol}: automatic text manifests search and read without web-service credentials`, async ({
    request,
  }) => {
    const f = await setup(request, protocol);
    try {
      const text =
          '<html><script>neverExecute()</script>\n' +
          '普通背景资料\r\n'.repeat(15000) +
          '模型应读到这里🙂\n</html>',
        bytes = Buffer.from(text);
      const file = {
        id: crypto.randomUUID(),
        name: 'reference.html',
        mediaType: 'text/html',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const prepared = await request.post(`/api/conversations/${f.id}/attachments/uploads`, {
        headers,
        data: [file],
      });
      expect(prepared.status()).toBe(201);
      expect((await prepared.json())[0].attachment).toMatchObject({
        mediaType: 'text/plain',
        originalMediaType: 'text/html',
      });
      expect((await directUpload(request, f.id, file.id, bytes)).ok()).toBe(true);
      const parsed = await request.post(
        `/api/conversations/${f.id}/attachments/${file.id}/document`,
        { headers },
      );
      expect(parsed.status()).toBe(200);
      const submitted = await request.post(`/api/conversations/${f.id}/messages`, {
        headers,
        data: {
          requestId: crypto.randomUUID(),
          parentId: null,
          content: '读取目标段落',
          fileIds: [file.id],
          fileInputModes: { [file.id]: 'auto' },
          selection: { providerId, model: f.model },
        },
      });
      expect(submitted.status(), await submitted.text()).toBe(202);
      const { assistantId } = await submitted.json();
      await expect
        .poll(async () => (await f.snapshot()).messages.find((m) => m.id === assistantId)?.status, {
          timeout: 45000,
        })
        .toBe('completed');
      const answer = (await f.snapshot()).messages.find((m) => m.id === assistantId)!;
      expect(messageText(answer)).toContain('已按需读取附件：模型应读到这里🙂');
      expect(answer.tools?.calls.map((c) => c.call.name)).toEqual([
        'attachment_search',
        'attachment_read',
      ]);
      expect(answer.tools?.calls.every((c) => c.state === 'completed')).toBe(true);
      expect(answer.tools?.calls[1].result?.status).toBe('completed');
      expect(answer.generation?.context?.toolTokens).toBeGreaterThan(0);
      // The independent download returns the unchanged source, never an active HTML document.
      const content = await request.get(
        `/api/conversations/${f.id}/attachments/${file.id}/document/content`,
      );
      expect(content.headers()['x-content-type-options']).toBe('nosniff');
      expect(content.headers()['content-disposition']).toBe('attachment');
      expect(await content.text()).toBe(text);
    } finally {
      await request.delete(`/api/conversations/${f.id}`, { headers });
    }
  });
}

test('UTF-8 HTML, SVG, unknown and extensionless documents share the text pipeline; binary fails validation', async ({
  request,
}) => {
  const f = await setup(request, 'openai-chat');
  try {
    for (const [name, mediaType, text] of [
      ['source.svg', 'image/svg+xml', '<svg><script>no()</script></svg>'],
      ['custom.any', '', '无扩展类型🙂'],
      ['Dockerfile', 'application/octet-stream', 'FROM scratch\n'],
    ]) {
      const bytes = Buffer.from(text),
        file = {
          id: crypto.randomUUID(),
          name,
          mediaType,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      expect(
        (
          await request.post(`/api/conversations/${f.id}/attachments/uploads`, {
            headers,
            data: [file],
          })
        ).status(),
      ).toBe(201);
      expect((await directUpload(request, f.id, file.id, bytes)).ok()).toBe(true);
      expect(
        (
          await request.post(`/api/conversations/${f.id}/attachments/${file.id}/document`, {
            headers,
          })
        ).status(),
      ).toBe(200);
    }
    const bytes = Buffer.from([0xc3, 0x28, 0xff]),
      file = {
        id: crypto.randomUUID(),
        name: 'invalid.html',
        mediaType: 'text/html',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    expect(
      (
        await request.post(`/api/conversations/${f.id}/attachments/uploads`, {
          headers,
          data: [file],
        })
      ).status(),
    ).toBe(201);
    expect((await directUpload(request, f.id, file.id, bytes)).ok()).toBe(true);
    expect(
      (
        await request.post(`/api/conversations/${f.id}/attachments/${file.id}/document`, {
          headers,
        })
      ).status(),
    ).toBe(415);
  } finally {
    await request.delete(`/api/conversations/${f.id}`, { headers });
  }
});

test('HTML preview is inert and paged; draft input mode survives reload and tool activity is visible', async ({
  page,
  request,
}) => {
  const f = await setup(request, 'openai-chat');
  try {
    await page.goto(`/c/${f.id}`);
    await page.request.post('/__dev/access/login');
    await page.reload();
    const text =
      '<script>window.htmlExecuted = true</script>\n' +
      '背景资料\n'.repeat(3000) +
      '模型应读到这里🙂';
    await page
      .getByLabel('选择聊天文件')
      .setInputFiles({ name: 'reference.html', mimeType: 'text/html', buffer: Buffer.from(text) });
    const preview = page.getByRole('button', { name: '预览 reference.html' });
    await preview.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('pre')).toContainText('<script>');
    expect(
      await page.evaluate(() => (window as unknown as { htmlExecuted?: boolean }).htmlExecuted),
    ).toBeUndefined();
    await dialog.getByRole('button', { name: '下一段' }).click();
    await expect(dialog.locator('pre')).not.toContainText('<script>');
    await dialog.getByRole('button', { name: '上一段' }).click();
    await expect(dialog.locator('pre')).toContainText('<script>');
    await dialog
      .getByRole('combobox', { name: 'reference.html 的输入方式' })
      .selectOption('on_demand');
    await dialog.getByRole('button', { name: '关闭文件预览' }).click();
    await page.reload();
    await preview.click();
    await expect(dialog.getByRole('combobox', { name: 'reference.html 的输入方式' })).toHaveValue(
      'on_demand',
    );
    await dialog.getByRole('button', { name: '关闭文件预览' }).click();
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByTestId('assistant-message')).toContainText('已按需读取附件');
    await expect(page.getByTestId('tool-call')).toHaveCount(2);
  } finally {
    await request.delete(`/api/conversations/${f.id}`, { headers });
  }
});
