import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Snapshot } from '../../shared/types';

const headers = { Origin: 'http://127.0.0.1:5174' };
async function setup(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const id = crypto.randomUUID();
  expect((await request.post('/api/conversations', { headers, data: { id, title: '复制源对话' } })).status()).toBe(201);
  expect((await request.post(`/api/__test/conversations/${id}/search-history`, { headers, data: {} })).ok()).toBe(true);
  return { id, cleanup: async (copy?: string) => { await request.delete(`/api/conversations/${id}`, { headers }); if (copy) await request.delete(`/api/conversations/${copy}`, { headers }); } };
}

test('copying a conversation creates a new URL with the same messages and independent IDs', async ({ page }) => {
  const source = await setup(page.request);
  const copyIds: string[] = [];
  try {
    const original = await page.request.get(`/api/conversations/${source.id}`).then((response) => response.json()) as Snapshot;
    const copied = await page.request.post(`/api/conversations/${source.id}/duplicate`, { headers });
    expect(copied.status()).toBe(201);
    const result = await copied.json() as { id: string; snapshot: Snapshot; conversation: { title: string } };
    copyIds.push(result.id);
    expect(result.id).not.toBe(source.id);
    expect(result.conversation.title).toBe('复制源对话 副本');
    expect(result.snapshot.messages.map(({ content, reasoning, modelName }) => ({ content, reasoning, modelName }))).toEqual(
      original.messages.map(({ content, reasoning, modelName }) => ({ content, reasoning, modelName })),
    );
    expect(result.snapshot.messages.map(({ id }) => id)).not.toEqual(original.messages.map(({ id }) => id));

    await page.goto(`/c/${source.id}`);
    await page.getByRole('button', { name: '管理对话', exact: true }).click();
    await page.getByRole('button', { name: '复制对话', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
    const uiCopyId = new URL(page.url()).pathname.split('/').at(-1)!;
    copyIds.push(uiCopyId);
    expect(uiCopyId).not.toBe(source.id);
    await expect(page.getByText('复制源对话 副本', { exact: true })).toBeVisible();
    await expect(page.getByTestId('assistant-message')).toHaveCount(2);
  } finally { await page.request.delete(`/api/conversations/${source.id}`, { headers }); for (const id of copyIds) await page.request.delete(`/api/conversations/${id}`, { headers }); }
});
