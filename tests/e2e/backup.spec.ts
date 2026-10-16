import { test, expect, type APIRequestContext } from '@playwright/test';
import type { ProviderSettings, Snapshot } from '../../shared/types';
import type { EverChatBackup } from '../../shared/backup';
import { readFile } from 'node:fs/promises';

const headers = { Origin: 'http://127.0.0.1:5174' };
const fixture = (request: APIRequestContext, id: string, name: string) => request.post(`/api/__test/conversations/${id}/${name}`, { headers, data: {} });

async function setup(request: APIRequestContext) {
  expect((await request.post('/api/login', { headers, data: { password: 'everchat-local' } })).ok()).toBe(true);
  const original = await request.get('/api/settings/providers').then((response) => response.json()) as ProviderSettings;
  const providerId = crypto.randomUUID();
  const settings = { providers: [{ id: providerId, name: '备份测试供应商', provider: 'openai-chat', baseUrl: 'https://provider.test/v1', apiKey: 'backup-test-secret', models: [{ id: 'backup-test', name: '备份测试模型', enabled: true }] }], activeProviderId: providerId, activeModel: 'backup-test', systemPrompt: '测试系统提示词', maxOutputTokens: null, showReasoning: true };
  expect((await request.put('/api/settings/providers', { headers, data: settings })).ok()).toBe(true);
  const id = crypto.randomUUID();
  expect((await request.post('/api/conversations', { headers, data: { id, title: '备份源对话' } })).status()).toBe(201);
  expect((await fixture(request, id, 'search-history')).ok()).toBe(true);
  return { id, original, cleanup: async (extra?: string) => {
    await request.delete(`/api/conversations/${id}`, { headers });
    if (extra) await request.delete(`/api/conversations/${extra}`, { headers });
    expect((await request.put('/api/settings/providers', { headers, data: original })).ok()).toBe(true);
  } };
}

test('versioned backups exclude API keys and restore messages with model metadata', async ({ request }) => {
  const source = await setup(request);
  try {
    const response = await request.get(`/api/conversations/${source.id}/backup`, { headers });
    expect(response.ok()).toBe(true);
    const backup = await response.json() as EverChatBackup;
    expect(backup.format).toBe('everchat-backup');
    expect(backup.version).toBe(1);
    expect(backup.conversation.messages.length).toBeGreaterThan(0);
    for (const message of backup.conversation.messages) {
      expect(message.parts).toBeInstanceOf(Array);
      expect(message).not.toHaveProperty('content'); expect(message).not.toHaveProperty('reasoning');
    }
    expect(backup.settings.providers[0]).not.toHaveProperty('apiKey');
    expect(JSON.stringify(backup)).not.toContain('backup-test-secret');
    expect(backup.settings.showReasoning).toBe(true);

    const restoredResponse = await request.post('/api/backup/restore', { headers, data: backup });
    expect(restoredResponse.status()).toBe(201);
    const restored = await restoredResponse.json() as { id: string; snapshot: Snapshot };
    expect(restored.id).not.toBe(source.id);
    for (const message of restored.snapshot.messages) {
      expect(message).not.toHaveProperty('content'); expect(message).not.toHaveProperty('reasoning');
    }
    expect(restored.snapshot.messages.map(({ parts, modelName }) => ({ parts, modelName }))).toEqual(
      backup.conversation.messages.map(({ parts, modelName }) => ({ parts, modelName })),
    );
    const restoredSettings = await request.get('/api/settings/providers', { headers }).then((result) => result.json()) as ProviderSettings;
    expect(restoredSettings.activeProviderId).toBeNull();
    await source.cleanup(restored.id);
  } catch (error) {
    await source.cleanup();
    throw error;
  }
});

test('the client can download text formats and import a backup into a new conversation', async ({ page }) => {
  const source = await setup(page.request);
  let restoredId = '';
  try {
    await page.goto(`/c/${source.id}`);
    await expect(page.getByTestId('assistant-message')).toHaveCount(2);
    const menu = page.getByRole('button', { name: '更多会话操作', exact: true });
    await menu.click();
    const markdown = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Markdown', exact: true }).click();
    const markdownFile = await markdown;
    expect(markdownFile.suggestedFilename()).toMatch(/\.md$/);
    const markdownText = await readFile((await markdownFile.path())!, 'utf8');
    expect(markdownText).toContain('跨越 **格式** 搜索。'); expect(markdownText).toContain('末尾思考终点');
    await menu.click();
    const text = page.waitForEvent('download'); await page.getByRole('menuitem', { name: '纯文本', exact: true }).click();
    const textFile = await text;
    expect(textFile.suggestedFilename()).toMatch(/\.txt$/);
    const plainText = await readFile((await textFile.path())!, 'utf8');
    expect(plainText).toContain('用户 TARGET 与 [a+b] 😀'); expect(plainText).toContain('末尾思考终点');
    await menu.click();
    const html = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'HTML', exact: true }).click();
    const htmlFile = await html;
    expect(htmlFile.suggestedFilename()).toMatch(/\.html$/);
    const htmlText = await readFile((await htmlFile.path())!, 'utf8');
    expect(htmlText).toContain('第二个回答 target，Unicode 😀 中文。'); expect(htmlText).toContain('<summary>思考过程</summary>');
    expect(htmlText).toContain('末尾思考终点');
    await menu.click();
    const backupDownload = page.waitForEvent('download'); await page.getByRole('menuitem', { name: '下载备份', exact: true }).click(); const backupFile = await backupDownload;
    expect(backupFile.suggestedFilename()).toMatch(/\.everchat\.zip$/);
    const archive = await readFile((await backupFile.path())!);
    await page.getByRole('banner').locator('input[type="file"]').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: archive });
    await expect(page).not.toHaveURL((url) => url.pathname === `/c/${source.id}`);
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}(?:\?branch=[^#]+)?$/);
    restoredId = new URL(page.url()).pathname.split('/').at(-1)!;
    expect(restoredId).not.toBe(source.id);
    await expect(page.getByTestId('assistant-message')).toHaveCount(2);
    await expect(page.getByRole('banner').getByText('备份源对话', { exact: true })).toBeVisible();
  } finally { await source.cleanup(restoredId || undefined); }
});
