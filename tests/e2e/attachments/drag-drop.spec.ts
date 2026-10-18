import { expect, test, type Page } from '@playwright/test';
import type { ProviderSettings } from '../../../shared/providers/types';
import { openSpaceSettings } from '../../support/browser/ui';
const headers = { Origin: 'http://127.0.0.1:5174' };
const png = [
  ...Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    'base64',
  ),
];
async function setup(page: Page) {
  await page.request.post('/__dev/access/login', { headers });
  const original = (await page.request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID();
  await page.request.put('/api/settings/providers', {
    headers,
    data: {
      ...original,
      providers: [
        {
          id: providerId,
          name: '拖放测试',
          provider: 'openai-chat',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'integration-test-key',
          models: [
            {
              id: 'vision-openai-chat',
              name: '视觉模型',
              enabled: true,
              metadataOverrides: { imageInput: true, contextWindow: 200000 },
            },
          ],
        },
      ],
      activeProviderId: providerId,
      activeModel: 'vision-openai-chat',
    },
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
  return async () => {
    const match = /\/c\/([\w-]+)/.exec(new URL(page.url()).pathname);
    if (match) await page.request.delete(`/api/conversations/${match[1]}`, { headers });
    await page.request.put('/api/settings/providers', { headers, data: original });
  };
}
async function drag(
  page: Page,
  type: string,
  files: { name: string; type: string; bytes: number[] }[],
  selector = '[data-chat-drop-zone]',
) {
  return page.locator(selector).evaluate(
    (node, { type, files }) => {
      const data = new DataTransfer();
      for (const file of files)
        data.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
      return !node.dispatchEvent(
        new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    },
    { type, files },
  );
}
const text = { name: '拖入文档.txt', type: 'text/plain', bytes: [...Buffer.from('本地拖放内容')] };

test('mixed image and file drop adds to the draft, preserves its text and focus, and never sends a message', async ({
  page,
}) => {
  const cleanup = await setup(page);
  try {
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('保留输入草稿');
    const files = [text, { name: '图片.png', type: 'image/png', bytes: png }];
    await drag(page, 'dragenter', files);
    await expect(page.getByTestId('file-drop-overlay')).toBeVisible();
    await drag(page, 'dragenter', files, '[data-testid="chat-composer"]');
    await drag(page, 'dragleave', files, '[data-testid="chat-composer"]');
    await expect(page.getByTestId('file-drop-overlay')).toBeVisible();
    expect(await drag(page, 'drop', files)).toBe(true);
    await expect(page).toHaveURL(/\/c\/[\w-]+$/);
    await expect(page.getByLabel('移除 拖入文档.txt')).toBeVisible();
    await expect(page.getByRole('button', { name: /移除 图片/ })).toBeVisible();
    await expect(page.getByTestId('file-drop-overlay')).toHaveCount(0);
    await expect(composer).toHaveValue('保留输入草稿');
    await expect(composer).toBeFocused();
    await expect(page.getByTestId('user-message')).toHaveCount(0);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    const snapshot = await page.request.get(`/api/conversations/${id}`).then((r) => r.json());
    expect(snapshot.messages).toEqual([]);
  } finally {
    await cleanup();
  }
});

test('invalid files do not discard successful attachments, and dialogs reject underlying drops without navigation', async ({
  page,
}) => {
  const cleanup = await setup(page);
  try {
    await drag(page, 'drop', [
      { name: 'invalid.exe', type: 'application/octet-stream', bytes: [1, 2, 3] },
      text,
    ]);
    await expect(page.getByLabel('移除 拖入文档.txt')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'invalid.exe' })).toBeVisible();
    const before = page.url();
    await openSpaceSettings(page);
    expect(await drag(page, 'drop', [text], '[role="dialog"]')).toBe(true);
    await expect(page.getByTestId('file-drop-overlay')).toHaveCount(0);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByLabel('移除 拖入文档.txt')).toHaveCount(1);
    expect(page.url()).toBe(before);
    const prevented = await page.locator('[data-chat-drop-zone]').evaluate((node) => {
      const data = new DataTransfer();
      data.setData('text/plain', '拖动的普通文本');
      return !node.dispatchEvent(
        new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    });
    expect(prevented).toBe(false);
  } finally {
    await cleanup();
  }
});
