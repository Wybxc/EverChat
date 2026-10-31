import { expect, test } from '@playwright/test';
import { modelSelectionKey } from '../../../shared/models/selection';
import type { ProviderSettings } from '../../../shared/providers/types';
import { openSpaceSettings } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };

test('provider switch autosaves, survives restart, hides models and restores original model toggles', async ({
  page,
}) => {
  await page.request.post('/__dev/access/login', { headers });
  const initial = (await page.request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providers = ['主要供应商', '备用供应商'].map((name) => ({
    id: crypto.randomUUID(),
    name,
    provider: 'openai-chat' as const,
    baseUrl: 'https://provider.test/v1',
    apiKey: 'integration-test-key',
    models: [
      { id: 'same-model', name: '同名模型', enabled: true },
      { id: 'unused-model', name: '未启用模型', enabled: false },
    ],
  }));
  const read = () =>
    page.request.get('/api/settings/providers').then((r) => r.json()) as Promise<ProviderSettings>;
  try {
    expect(
      (
        await page.request.put('/api/settings/providers', {
          headers,
          data: {
            ...initial,
            providers,
            activeProviderId: providers[0].id,
            activeModel: 'same-model',
            title: { automatic: true, model: { providerId: providers[0].id, model: 'same-model' } },
          },
        })
      ).ok(),
    ).toBe(true);
    let writes = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().endsWith('/api/settings/providers')) writes++;
    });
    await page.goto('/');
    await openSpaceSettings(page);
    const dialog = page.getByRole('dialog', { name: '设置', exact: true });
    await dialog.getByRole('tab', { name: '供应商', exact: true }).click();
    const toggle = page.getByRole('switch', { name: '启用供应商', exact: true });
    await expect(toggle).toBeChecked();
    await page.waitForTimeout(900);
    expect(writes).toBe(0);
    await toggle.click();
    await expect.poll(async () => (await read()).providers[0].enabled).toBe(false);
    expect((await read()).activeProviderId).toBe(providers[1].id);
    await expect(dialog.getByText('已禁用', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '聊天模型', exact: true })).toHaveAttribute(
      'data-model-key',
      modelSelectionKey({ providerId: providers[1].id, model: 'same-model' }),
    );
    const session = await page.request.get('/api/session').then((r) => r.json());
    expect(session.titleModelConfigured).toBe(false);
    expect(session.models.map((m: { providerId: string }) => m.providerId)).toEqual([
      providers[1].id,
    ]);
    await page.request.post('/api/__test/library/attachments', {
      headers,
      data: { resetLibrary: true },
    });
    await page.reload();
    await openSpaceSettings(page);
    await dialog.getByRole('tab', { name: '供应商', exact: true }).click();
    await dialog.getByRole('button', { name: '主要供应商', exact: false }).click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByLabel('启用模型 同名模型', { exact: true })).toBeChecked();
    await expect(page.getByLabel('启用模型 未启用模型', { exact: true })).not.toBeChecked();
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(toggle).toBeInViewport();
    await toggle.click();
    await expect.poll(async () => (await read()).providers[0].enabled === false).toBe(false);
    const saved = (await read()).providers[0];
    expect(saved.apiKey).toBe(providers[0].apiKey);
    expect(saved.baseUrl).toBe(providers[0].baseUrl);
    expect(saved.models.map((m) => [m.id, m.enabled])).toEqual([
      ['same-model', true],
      ['unused-model', false],
    ]);
    expect((await page.request.get('/api/session').then((r) => r.json())).models).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath('provider-switch-mobile.png') });
  } finally {
    await page.close();
    await page.request.put('/api/settings/providers', { headers, data: initial });
  }
});
