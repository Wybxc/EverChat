import { expect, test } from '@playwright/test';
import type { Snapshot } from '../../../shared/streaming/protocol';
import type { SharePreview, SharePage } from '../../../shared/sharing/types';

const origin = 'http://127.0.0.1:5174',
  headers = { Origin: origin };
test('immutable selected-branch sharing stays anonymous, revocable and isolated from private startup', async ({
  request,
  browser,
}) => {
  test.setTimeout(90_000);
  await request.post('/__dev/access/login', { headers });
  const previous = await request.get('/api/settings/providers').then((r) => r.json());
  const conversationId = crypto.randomUUID(),
    providerId = crypto.randomUUID();
  const anonymous = await browser.newContext();
  const secretText = 'private-model-and-system-must-not-leak';
  try {
    expect(
      (
        await request.put('/api/settings/providers', {
          headers,
          data: {
            providers: [
              {
                id: providerId,
                name: secretText,
                provider: 'openai-chat',
                baseUrl: 'https://provider.test/v1',
                apiKey: 'integration-test-key',
                models: [{ id: 'raw-openai-chat', name: secretText, enabled: true }],
              },
            ],
            activeProviderId: providerId,
            activeModel: 'raw-openai-chat',
            systemPrompt: secretText,
            maxOutputTokens: null,
          },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.post('/api/conversations', {
          headers,
          data: { id: conversationId, title: '公开分享验收' },
        })
      ).ok(),
    ).toBe(true);
    const snapshot = () =>
      request
        .get(`/api/conversations/${conversationId}`)
        .then((r) => r.json()) as Promise<Snapshot>;
    const submit = async (data: object) => {
      const response = await request.post(`/api/conversations/${conversationId}/messages`, {
        headers,
        data: { requestId: crypto.randomUUID(), ...data },
      });
      expect(response.status()).toBe(202);
      const result = await response.json();
      await expect
        .poll(
          async () => (await snapshot()).messages.find((m) => m.id === result.assistantId)?.status,
        )
        .toBe('completed');
      return result as { userId: string; assistantId: string };
    };
    const content =
      '# 分享标题\n第一行\n第二行\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$$x^2$$\n\n```js\nconst a = 1;\n```\n\n<script>window.__shareXss = true</script>\n<img src="https://tracker.invalid/hidden" onerror="window.__shareXss = true">\n[危险](javascript:alert(1))\n![外部图片](https://tracker.invalid/pixel.png)';
    const first = await submit({ parentId: null, content });
    const preview = async (
      headId: string,
      includeReasoning = false,
      operationId = crypto.randomUUID(),
    ) => {
      const response = await request.post('/api/shares/preview', {
        headers,
        data: { operationId, conversationId, headId, includeReasoning },
      });
      expect(response.status(), await response.text()).toBe(200);
      return response.json() as Promise<SharePreview>;
    };
    const operationId = crypto.randomUUID();
    const simultaneous = await Promise.all(
      Array.from({ length: 3 }, () => preview(first.assistantId, false, operationId)),
    );
    const draft = simultaneous[0];
    expect(simultaneous.map((value) => value.share.id)).toEqual(Array(3).fill(draft.share.id));
    expect(simultaneous.map((value) => value.share.hash)).toEqual(Array(3).fill(draft.share.hash));
    expect(draft.share.messageCount).toBe(2);
    const publish = (value: SharePreview) =>
      request.post(`/api/shares/${value.share.id}/publish`, {
        headers,
        data: { hash: value.share.hash, title: '公开标题', expiry: 7 },
      });
    const result = await publish(draft);
    expect(result.status(), await result.text()).toBe(200);
    const published = (await result.json()) as { share: { id: string }; secret: string };
    const publicPath = `/public/shares/${published.share.id}`,
      bearer = { Authorization: `Bearer ${published.secret}` };
    expect((await anonymous.request.get(publicPath)).status()).toBe(404);
    const read = await anonymous.request.get(publicPath, { headers: bearer });
    expect(read.status()).toBe(200);
    expect(read.headers()['cache-control']).toBe('no-store');
    const body = await read.json();
    expect(JSON.stringify(body)).not.toMatch(
      /private-model|integration-test-key|providerId|conversationId|runId|generation|summary|tokenCipher/,
    );
    expect(body.share.includeReasoning).toBe(false);
    const frozen = JSON.stringify(body);
    // Creating a new revision neither publishes it nor mutates the frozen branch.
    const second = await submit({ revisionOf: first.userId, content: '另一分支不可公开' });
    expect(
      JSON.stringify(
        await anonymous.request.get(publicPath, { headers: bearer }).then((r) => r.json()),
      ),
    ).toBe(frozen);
    const stale = await preview(second.assistantId);
    await submit({ parentId: second.assistantId, content: '预览之后增加' });
    expect((await publish(stale)).status()).toBe(409);
    const page = await anonymous.newPage();
    const privateCalls: string[] = [],
      tracker: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api')) privateCalls.push(r.url());
      if (r.url().includes('tracker.invalid')) tracker.push(r.url());
    });
    await page.addInitScript(() => {
      indexedDB.open = () => {
        throw new Error('Public page must not open private databases');
      };
    });
    await page.goto(`/s/${published.share.id}#${published.secret}`);
    await expect(page.getByRole('heading', { name: '公开标题', exact: true })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.locator('.katex').first()).toBeVisible();
    await expect(page.locator('code').first()).toBeVisible();
    expect(privateCalls).toEqual([]);
    expect(tracker).toEqual([]);
    expect(await page.evaluate(() => '__shareXss' in window)).toBe(false);
    expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
    await page.screenshot({ path: '/tmp/everchat-public-share-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 740 });
    await page.getByLabel('颜色模式').selectOption('dark');
    await page.screenshot({ path: '/tmp/everchat-public-share-phone.png', fullPage: true });
    const rotated = await request
      .patch(`/api/shares/${published.share.id}`, { headers, data: { rotate: true } })
      .then((r) => r.json());
    expect((await anonymous.request.get(publicPath, { headers: bearer })).status()).toBe(404);
    expect((await anonymous.request.head(publicPath, { headers: bearer })).status()).toBe(404);
    const newHeaders = { Authorization: `Bearer ${rotated.secret}` };
    expect((await anonymous.request.get(publicPath, { headers: newHeaders })).status()).toBe(200);
    const copy = await request.get(`/api/shares/${published.share.id}/link`).then((r) => r.json());
    expect(copy.secret).toBe(rotated.secret);
    const included = await preview(first.assistantId, true),
      includedPublished = await publish(included).then((r) => r.json());
    const reasoning = await anonymous.request
      .get(`/public/shares/${included.share.id}`, {
        headers: { Authorization: `Bearer ${includedPublished.secret}` },
      })
      .then((r) => r.json());
    expect(reasoning.share.includeReasoning).toBe(true);
    expect(reasoning.page.blocks.some((b: { channel: string }) => b.channel === 'reasoning')).toBe(
      true,
    );
    expect((await request.post(`/api/shares/${published.share.id}/revoke`, { headers })).ok()).toBe(
      true,
    );
    expect((await anonymous.request.get(publicPath, { headers: newHeaders })).status()).toBe(404);
    expect(
      (
        await anonymous.request.get(publicPath + '/messages?cursor=0', { headers: newHeaders })
      ).status(),
    ).toBe(404);
    expect((await request.delete(`/api/conversations/${conversationId}`, { headers })).ok()).toBe(
      true,
    );
    expect(
      (
        await anonymous.request.get(`/public/shares/${included.share.id}`, {
          headers: { Authorization: `Bearer ${includedPublished.secret}` },
        })
      ).status(),
    ).toBe(404);
    expect((await anonymous.request.get('/api/shares')).status()).toBe(401);
    expect((await request.delete(`/api/shares/${published.share.id}`, { headers })).ok()).toBe(
      true,
    );
  } finally {
    await anonymous.close();
    expect((await request.put('/api/settings/providers', { headers, data: previous })).ok()).toBe(
      true,
    );
  }
});

test('large snapshots page deterministically and revalidate every read', async ({ request }) => {
  await request.post('/__dev/access/login', { headers });
  const previous = await request.get('/api/settings/providers').then((r) => r.json());
  const providerId = crypto.randomUUID(),
    id = crypto.randomUUID();
  try {
    await request.put('/api/settings/providers', {
      headers,
      data: {
        providers: [
          {
            id: providerId,
            name: '分页供应商',
            provider: 'openai-chat',
            baseUrl: 'https://provider.test/v1',
            apiKey: 'integration-test-key',
            models: [{ id: 'raw-openai-chat', name: '分页模型', enabled: true }],
          },
        ],
        activeProviderId: providerId,
        activeModel: 'raw-openai-chat',
        systemPrompt: '',
        maxOutputTokens: null,
      },
    });
    await request.post('/api/conversations', { headers, data: { id, title: '大快照分页' } });
    const text = '😀大快照\n'.repeat(15_000).trimEnd(),
      response = await request.post(`/api/conversations/${id}/messages`, {
        headers,
        data: { requestId: crypto.randomUUID(), parentId: null, content: '分页验证' },
      });
    expect(response.status()).toBe(202);
    const submitted = await response.json();
    await expect
      .poll(async () =>
        request
          .get(`/api/conversations/${id}`)
          .then((r) => r.json())
          .then((r) => r.messages.at(-1).status),
      )
      .toBe('completed');
    const edited = await request.patch(
      `/api/conversations/${id}/messages/${submitted.assistantId}`,
      { headers, data: { requestId: crypto.randomUUID(), content: text } },
    );
    expect(edited.status(), await edited.text()).toBe(201);
    const revised = await edited.json();
    const preview = (await request
      .post('/api/shares/preview', {
        headers,
        data: {
          operationId: crypto.randomUUID(),
          conversationId: id,
          headId: revised.messageId,
          includeReasoning: false,
        },
      })
      .then((r) => r.json())) as SharePreview;
    const published = await request
      .post(`/api/shares/${preview.share.id}/publish`, {
        headers,
        data: { hash: preview.share.hash, title: '大快照', expiry: null },
      })
      .then((r) => r.json());
    const bearer = { Authorization: `Bearer ${published.secret}` },
      path = `/public/shares/${preview.share.id}`;
    const first = await request.get(path, { headers: bearer }).then((r) => r.json());
    let page: SharePage = first.page,
      content = '';
    expect(page.cursor).not.toBeNull();
    for (;;) {
      content += page.blocks
        .filter((b) => b.role === 'assistant')
        .map((b) => b.text)
        .join('');
      if (page.cursor === null) break;
      page = await request
        .get(`${path}/messages?cursor=${page.cursor}`, { headers: bearer })
        .then((r) => r.json());
    }
    expect(content).toBe(text);
    await request.post(`/api/shares/${preview.share.id}/revoke`, { headers });
    expect(
      (
        await request.get(`${path}/messages?cursor=4`, {
          headers: { ...bearer, 'If-None-Match': first.share.hash },
        })
      ).status(),
    ).toBe(404);
    await request.delete(`/api/conversations/${id}`, { headers });
  } finally {
    await request.put('/api/settings/providers', { headers, data: previous });
  }
});
