import { expect, test } from '@playwright/test';
import { validateBackup } from '../../../shared/backup/backup';
import { messageText } from '../../../shared/conversation/content';
import { MAX_MESSAGE_TEXT_BYTES } from '../../../shared/conversation/limits';
import type { ProviderSettings } from '../../../shared/providers/types';
import type { Snapshot } from '../../../shared/streaming/protocol';

const headers = { Origin: 'http://127.0.0.1:5174' };

test('session serves every enabled model from a large configured directory without exposing keys', async ({
  request,
}) => {
  await request.post('/__dev/access/login', { headers });
  const original = (await request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID();
  try {
    const saved = await request.put('/api/settings/providers', {
      headers,
      data: {
        ...original,
        activeProviderId: providerId,
        activeModel: 'model-0',
        providers: [
          {
            id: providerId,
            name: '供'.repeat(100),
            provider: 'openai-chat',
            baseUrl: 'https://provider.test/v1',
            apiKey: 'private-large-directory-key',
            models: Array.from({ length: 1_000 }, (_, index) => ({
              id: `model-${index}`,
              name: '名'.repeat(200),
              enabled: true,
            })),
          },
        ],
      },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    const response = await request.get('/api/session');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    const text = await response.text();
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(1_000_000);
    expect(text).not.toContain('private-large-directory-key');
    expect(text).not.toContain('apiKey');
    const session = JSON.parse(text);
    expect(session).toMatchObject({ authenticated: true, activeProviderId: providerId });
    expect(session.identity.email).toBeTruthy();
    expect(session.models).toHaveLength(1_000);
    expect(session.models[999]).toMatchObject({
      providerId,
      model: 'model-999',
      name: '名'.repeat(200),
    });
  } finally {
    await request.put('/api/settings/providers', { headers, data: original });
  }
});

test('long input, > 4 MiB wire, long thoughts, edits and backup restore share the relaxed policy', async ({
  request,
}) => {
  await request.post('/__dev/access/login', { headers });
  const original = (await request
    .get('/api/settings/providers')
    .then((r) => r.json())) as ProviderSettings;
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID();
  const created = [id];
  try {
    const settings = {
      providers: [
        {
          id: providerId,
          name: 'Long stream fixture',
          provider: 'openai-chat',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'integration-test-key',
          models: [
            {
              id: 'alarm-free-tier-large',
              name: 'Long stream',
              enabled: true,
              reasoningSupport: 'supported',
              metadataOverrides: { contextWindow: 1_000_000, maxOutputTokens: 200_000 },
            },
          ],
        },
      ],
      activeProviderId: providerId,
      activeModel: 'alarm-free-tier-large',
      systemPrompt: 's'.repeat(64_000),
      maxOutputTokens: 150_000,
    };
    const saved = await request.put('/api/settings/providers', { headers, data: settings });
    expect(saved.status(), await saved.text()).toBe(200);
    expect(
      (
        await request.post('/api/conversations', { headers, data: { id, title: 'Long stream' } })
      ).status(),
    ).toBe(201);
    const snapshot = () =>
      request.get(`/api/conversations/${id}`).then((r) => r.json()) as Promise<Snapshot>;
    const content = '问'.repeat(20_000);
    const sent = await request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        parentId: null,
        content,
      },
    });
    expect(sent.status(), await sent.text()).toBe(202);
    await expect.poll(async () => (await snapshot()).messages[1]?.status).toBe('completed');
    const final = await snapshot();
    expect(messageText(final.messages[0])).toBe(content);
    expect(messageText(final.messages[1])).toBe('答'.repeat(110_000));
    expect(messageText(final.messages[1], 'reasoning')).toBe('思'.repeat(110_000));
    expect(final.messages[1].durableOffset).toBeGreaterThan(4 * 1024 * 1024);

    const edited = '改'.repeat(120_000);
    const revision = await request.patch(
      `/api/conversations/${id}/messages/${final.messages[1].id}`,
      {
        headers,
        data: { requestId: crypto.randomUUID(), content: edited },
      },
    );
    expect(revision.status(), await revision.text()).toBe(201);
    const revisionId = (await revision.json()).messageId;
    expect(messageText((await snapshot()).messages.find((m) => m.id === revisionId))).toBe(edited);

    const backupResponse = await request.get(`/api/conversations/${id}/backup`);
    expect(backupResponse.status(), await backupResponse.text()).toBe(200);
    const backup = validateBackup(await backupResponse.json());
    expect(backup.settings.systemPrompt).toHaveLength(64_000);
    expect(backup.settings.maxOutputTokens).toBe(150_000);
    const restored = await request.post('/api/backup/restore', { headers, data: backup });
    expect(restored.status(), await restored.text()).toBe(201);
    const result = await restored.json();
    created.push(result.id);
    expect(result.snapshot.messages.map((m: Snapshot['messages'][number]) => m.parts)).toEqual(
      backup.conversation.messages.map((m) => m.parts),
    );

    const tooLarge = await request.patch(`/api/conversations/${id}/messages/${revisionId}`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        content: '\u0000'.repeat(Math.floor(MAX_MESSAGE_TEXT_BYTES / 6) + 1),
      },
    });
    expect(tooLarge.status()).toBe(400);
    expect((await snapshot()).messages).toHaveLength(3);
  } finally {
    for (const conversationId of created)
      await request.delete(`/api/conversations/${conversationId}`, { headers });
    await request.put('/api/settings/providers', { headers, data: original });
  }
});
