import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Submission, SubmitInput } from '../../../shared/conversation/types';
import type { ProviderSettings, ProviderSettingsInput } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { chooseChatModel, expectChatModel } from '../../support/browser/ui';

const headers = { Origin: 'http://127.0.0.1:5174' };
const model = 'benchmark-text-2-10-32';
async function setup(request: APIRequestContext) {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = (await request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const providers = [crypto.randomUUID(), crypto.randomUUID()];
  const settings: ProviderSettingsInput = {
    providers: providers.map((id, index) => ({
      id,
      name: `Model memory ${index + 1}`,
      provider: 'openai-chat',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'integration-test-key',
      models: [{ id: model, name: 'Shared model', enabled: true }],
    })),
    activeProviderId: providers[0],
    activeModel: model,
    systemPrompt: '',
    maxOutputTokens: null,
  };
  expect((await request.put('/api/settings/providers', { headers, data: settings })).ok()).toBe(
    true,
  );
  const ids: string[] = [];
  const complete = async (id: string, input: Omit<SubmitInput, 'requestId'>) => {
    const response = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: { ...input, requestId: crypto.randomUUID() },
    });
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as Submission;
    await expect
      .poll(async () => {
        const snapshot = (await request
          .get(`/api/conversations/${id}`)
          .then((r) => r.json())) as Snapshot;
        return snapshot.messages.find((message) => message.id === accepted.assistantId)?.status;
      })
      .toBe('completed');
    return accepted;
  };
  return {
    providers,
    settings,
    ids,
    keys: providers.map((id) => JSON.stringify([id, model])),
    complete,
    create: async (title: string, providerId: string) => {
      const id = crypto.randomUUID();
      ids.push(id);
      expect(
        (await request.post('/api/conversations', { headers, data: { id, title } })).ok(),
      ).toBe(true);
      const accepted = await complete(id, {
        parentId: null,
        content: title,
        selection: { providerId, model },
      });
      return { id, title, ...accepted };
    },
    cleanup: async () => {
      for (const id of ids) await request.delete(`/api/conversations/${id}`, { headers });
      await request.put('/api/settings/providers', { headers, data: original });
    },
  };
}

test('conversations restore their own models across navigation, history and reload', async ({
  page,
}) => {
  const fixture = await setup(page.request);
  try {
    const [firstKey, secondKey] = fixture.keys;
    const first = await fixture.create('Model memory first', fixture.providers[0]);
    const second = await fixture.create('Model memory second', fixture.providers[1]);
    await fixture.complete(first.id, {
      retryOf: first.assistantId,
      selection: { providerId: fixture.providers[1], model },
    });
    expect(
      (
        await page.request.patch(`/api/conversations/${first.id}/messages/${first.assistantId}`, {
          headers,
          data: { requestId: crypto.randomUUID(), content: 'Manually edited older answer' },
        })
      ).ok(),
    ).toBe(true);
    // Browsing an older answer does not restore that branch's older model.
    await page.goto(`/c/${first.id}?branch=${first.assistantId}`);
    await expectChatModel(page, secondKey);
    await chooseChatModel(page, firstKey);
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    await editor.fill('Keep the first draft');
    await page.getByRole('link', { name: second.title, exact: true }).click();
    await expectChatModel(page, secondKey);
    await editor.fill('Keep the second draft');
    await page.goBack();
    await expectChatModel(page, firstKey);
    await expect(editor).toHaveValue('Keep the first draft');
    await page.goForward();
    await expectChatModel(page, secondKey);
    await expect(editor).toHaveValue('Keep the second draft');
    await page.reload();
    await expectChatModel(page, secondKey);
    await page.getByRole('link', { name: first.title, exact: true }).click();
    await expectChatModel(page, firstKey);
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && r.url().endsWith(`/conversations/${first.id}/messages`),
    );
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    expect((await response).request().postDataJSON().selection).toEqual({
      providerId: fixture.providers[0],
      model,
    });
    await expect(page.getByTestId('assistant-message').last()).toHaveAttribute(
      'data-status',
      'completed',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('a new offline conversation keeps its selected model after other chats change the default', async ({
  page,
  context,
}) => {
  const fixture = await setup(page.request);
  try {
    await page.goto('/');
    await chooseChatModel(page, fixture.keys[1]);
    await context.setOffline(true);
    await page.getByLabel('消息', { exact: true }).fill('Offline model memory');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}/);
    const id = new URL(page.url()).pathname.split('/').at(-1)!;
    fixture.ids.push(id);
    await expectChatModel(page, fixture.keys[1]);
    await page.keyboard.press('ControlOrMeta+j');
    await chooseChatModel(page, fixture.keys[0]);
    await page.getByRole('link', { name: 'Offline model memory', exact: true }).click();
    await expectChatModel(page, fixture.keys[1]);
    await expect(page.getByTestId('pending-message')).toContainText('Model memory 2');
    await context.setOffline(false);
    await expect(page.getByTestId('assistant-message')).toHaveAttribute('data-status', 'completed');
    await page.reload();
    await expectChatModel(page, fixture.keys[1]);
    // A disabled saved selection falls back without rewriting the remembered model.
    await page.request.put('/api/settings/providers', {
      headers,
      data: {
        ...fixture.settings,
        providers: fixture.settings.providers.map((provider, index) => ({
          ...provider,
          models: provider.models.map((entry) => ({ ...entry, enabled: index === 0 })),
        })),
      },
    });
    await page.reload();
    await expectChatModel(page, fixture.keys[0]);
  } finally {
    await context.setOffline(false);
    await fixture.cleanup();
  }
});
