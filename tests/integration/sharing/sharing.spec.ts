import { expect, test } from '@playwright/test';
import type { Snapshot } from '../../../shared/streaming/protocol';
import type { SharePreview } from '../../../shared/sharing/types';

const origin = 'http://127.0.0.1:5174',
  headers = { Origin: origin };
test('immutable selected-branch sharing stays anonymous, fully readable and deletable without private startup', async ({
  request,
  browser,
}) => {
  test.setTimeout(90_000);
  await request.post('/__dev/access/login', { headers });
  const previous = await request.get('/api/settings/providers').then((r) => r.json());
  const conversationId = crypto.randomUUID(),
    providerId = crypto.randomUUID();
  const anonymous = await browser.newContext({ locale: 'zh-CN' });
  const secretText = 'private-system-must-not-leak',
    modelName = '公开模型显示名',
    providerName = 'private-provider-must-not-leak';
  try {
    expect(
      (
        await request.put('/api/settings/providers', {
          headers,
          data: {
            providers: [
              {
                id: providerId,
                name: providerName,
                provider: 'openai-chat',
                baseUrl: 'https://provider.test/v1',
                apiKey: 'integration-test-key',
                models: [{ id: 'raw-openai-chat', name: modelName, enabled: true }],
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
    const markdown =
      '# 分享标题\n第一行\n第二行\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$$x^2$$\n\n```js\nconst a = 1;\n```\n\n<script>window.__shareXss = true</script>\n<img src="https://tracker.invalid/hidden" onerror="window.__shareXss = true">\n[危险](javascript:alert(1))\n![外部图片](https://tracker.invalid/pixel.png)';
    const first = await submit({ parentId: null, content: '第一行\n第二行\n请检查分享 Markdown' });
    const edited = await request.patch(
      `/api/conversations/${conversationId}/messages/${first.assistantId}`,
      {
        headers,
        data: { requestId: crypto.randomUUID(), content: markdown },
      },
    );
    expect(edited.status()).toBe(201);
    const renderedHead = (await edited.json()).messageId as string;
    const preview = async (headId: string, operationId = crypto.randomUUID()) => {
      const response = await request.post('/api/shares/preview', {
        headers,
        data: { operationId, conversationId, headId },
      });
      expect(response.status(), await response.text()).toBe(200);
      return response.json() as Promise<SharePreview>;
    };
    const operationId = crypto.randomUUID();
    const simultaneous = await Promise.all(
      Array.from({ length: 3 }, () => preview(renderedHead, operationId)),
    );
    const draft = simultaneous[0];
    expect(simultaneous.map((value) => value.share.id)).toEqual(Array(3).fill(draft.share.id));
    expect(simultaneous.map((value) => value.share.hash)).toEqual(Array(3).fill(draft.share.hash));
    expect(draft.share.messageCount).toBe(2);
    const publish = (value: SharePreview) =>
      request.post(`/api/shares/${value.share.id}/publish`, {
        headers,
        data: { hash: value.share.hash, title: '公开标题' },
      });
    const result = await publish(draft);
    expect(result.status(), await result.text()).toBe(200);
    const published = (await result.json()) as { share: { id: string } };
    expect(published).not.toHaveProperty('secret');
    const publicPath = `/s/${published.share.id}`;
    const read = await anonymous.request.get(publicPath);
    expect(read.status(), await read.text()).toBe(200);
    expect(read.headers()['cache-control']).toBe('no-store');
    const body = await read.text();
    expect(body).toContain('<table');
    expect(body).toContain('const a = 1;');
    expect(body).not.toMatch(
      /private-|integration-test-key|providerId|conversationId|runId|tokenCipher/,
    );
    const frozen = body;
    const noScript = await browser.newContext({ javaScriptEnabled: false, locale: 'zh-CN' });
    try {
      const staticPage = await noScript.newPage();
      await staticPage.goto(publicPath);
      await expect(staticPage.getByRole('table')).toBeVisible();
      await expect(staticPage.getByText('第一行', { exact: false }).first()).toBeVisible();
      await expect(staticPage.locator('.katex').first()).toBeVisible();
    } finally {
      await noScript.close();
    }
    // Creating a new revision neither publishes it nor mutates the frozen branch.
    const second = await submit({ revisionOf: first.userId, content: '另一分支不可公开' });
    expect(await anonymous.request.get(publicPath).then((r) => r.text())).toBe(frozen);
    const stale = await preview(second.assistantId);
    await submit({ parentId: second.assistantId, content: '预览之后增加' });
    expect((await publish(stale)).status()).toBe(409);
    const page = await anonymous.newPage();
    const privateCalls: string[] = [],
      publicCalls: string[] = [],
      tracker: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/api')) privateCalls.push(r.url());
      if (r.url().includes('tracker.invalid')) tracker.push(r.url());
    });
    // Development StrictMode cancels its first effect; count completed transfers.
    page.on('requestfinished', (r) => {
      if (new URL(r.url()).pathname.startsWith('/public/')) publicCalls.push(r.url());
    });
    await page.addInitScript(() => {
      indexedDB.open = () => {
        throw new Error('Public page must not open private databases');
      };
    });
    await page.goto(publicPath);
    await expect(page.getByRole('heading', { name: '公开标题', exact: true })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.locator('.katex').first()).toBeVisible();
    await expect(page.locator('code').first()).toBeVisible();
    const userBubble = page.getByTestId('user-message').first();
    await expect(userBubble.locator('[data-share-user-text]')).toHaveText(
      '第一行\n第二行\n请检查分享 Markdown',
    );
    expect(
      await userBubble
        .locator('[data-slot="bubble-content"]')
        .evaluate((element) => getComputedStyle(element).whiteSpace),
    ).toBe('pre-wrap');
    await expect(page.getByRole('button', { name: '继续阅读', exact: true })).toHaveCount(0);
    expect(publicCalls).toEqual([]);
    expect(privateCalls).toEqual([]);
    expect(tracker).toEqual([]);
    expect(await page.evaluate(() => '__shareXss' in window)).toBe(false);
    expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
    await page.screenshot({ path: '/tmp/everchat-public-share-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 740 });
    await page.getByLabel('颜色模式').selectOption('dark');
    await page.screenshot({ path: '/tmp/everchat-public-share-phone.png', fullPage: true });
    expect((await anonymous.request.head(publicPath)).status()).toBe(200);
    expect(
      (
        await request.patch(`/api/shares/${published.share.id}`, {
          headers,
          data: { rotate: true },
        })
      ).status(),
    ).toBe(404);
    expect(
      (await request.post(`/api/shares/${published.share.id}/revoke`, { headers })).status(),
    ).toBe(404);
    const copy = await request.get(`/api/shares/${published.share.id}/link`).then((r) => r.json());
    expect(copy.share.id).toBe(published.share.id);
    expect(copy).not.toHaveProperty('secret');
    const included = await preview(first.assistantId);
    await publish(included);
    const reasoning = await anonymous.request.get(`/s/${included.share.id}`).then((r) => r.text());
    expect(reasoning).toContain('思考🙂');
    expect(reasoning).not.toContain(providerName);
    await page.goto(`/s/${included.share.id}`);
    const thought = page.getByTestId('assistant-message').getByTestId('share-reasoning');
    await expect(
      page.getByTestId('assistant-message').getByRole('heading', { name: modelName, exact: true }),
    ).toBeVisible();
    await expect(page.getByText(providerName, { exact: false })).toHaveCount(0);
    await expect(thought).not.toHaveAttribute('open');
    await thought.locator('summary').click();
    await expect(thought).toHaveAttribute('open', '');
    await expect(thought).toContainText('思考🙂');
    const timed = await preview(first.assistantId);
    expect(
      (
        await request.post(`/api/shares/${timed.share.id}/publish`, {
          headers,
          data: { hash: timed.share.hash, title: '到期验证', expiresAt: Date.now() - 1 },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await request.post(`/api/shares/${timed.share.id}/publish`, {
          headers,
          data: { hash: timed.share.hash, title: '到期验证', expiresAt: 'invalid' },
        })
      ).status(),
    ).toBe(400);
    const expiresAt = Date.now() + 2500;
    const timedPublication = await request
      .post(`/api/shares/${timed.share.id}/publish`, {
        headers,
        data: { hash: timed.share.hash, title: '到期验证', expiresAt },
      })
      .then((r) => r.json());
    expect(timedPublication.share.expiresAt).toBe(expiresAt);
    const timedPath = `/s/${timed.share.id}`;
    expect((await anonymous.request.get(timedPath)).status()).toBe(200);
    await page.goto(timedPath);
    await expect(page.getByRole('heading', { name: '到期验证', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('链接不可用');
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
    expect((await anonymous.request.get(timedPath)).status()).toBe(404);
    expect((await anonymous.request.head(timedPath)).status()).toBe(404);
    expect((await request.get(`/api/shares/${timed.share.id}/link`)).status()).toBe(404);
    // The real local DO alarm must remove metadata without a visitor-triggered write.
    await expect
      .poll(async () =>
        request
          .get('/api/shares')
          .then((r) => r.json())
          .then((r) => r.shares.some((share: { id: string }) => share.id === timed.share.id)),
      )
      .toBe(false);
    expect((await request.delete(`/api/shares/${published.share.id}`, { headers })).ok()).toBe(
      true,
    );
    expect((await anonymous.request.get(publicPath)).status()).toBe(404);
    expect((await anonymous.request.head(publicPath)).status()).toBe(404);
    expect((await request.get(`/api/shares/${published.share.id}/link`)).status()).toBe(404);
    expect(
      (
        await anonymous.request.get(`/public/shares/${published.share.id}/messages?cursor=0`)
      ).status(),
    ).toBe(404);
    expect((await request.delete(`/api/conversations/${conversationId}`, { headers })).ok()).toBe(
      true,
    );
    expect((await anonymous.request.get(`/s/${included.share.id}`)).status()).toBe(404);
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

test('large snapshots load completely in one response and deletion invalidates all subsequent reads', async ({
  request,
  browser,
}) => {
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
        },
      })
      .then((r) => r.json())) as SharePreview;
    const published = await request
      .post(`/api/shares/${preview.share.id}/publish`, {
        headers,
        data: { hash: preview.share.hash, title: '大快照' },
      })
      .then((r) => r.json());
    expect(published).not.toHaveProperty('secret');
    const path = `/s/${preview.share.id}`;
    const first = await request.get(path).then((r) => r.text());
    expect(first.match(/😀大快照/g)).toHaveLength(15_000);
    const anonymous = await browser.newContext({ locale: 'zh-CN' });
    try {
      const page = await anonymous.newPage(),
        calls: string[] = [];
      page.on('requestfinished', (r) => {
        if (new URL(r.url()).pathname.startsWith('/public/')) calls.push(r.url());
      });
      await page.goto(origin + path);
      expect(
        (await page.getByTestId('assistant-message').locator('.markdown').innerText()).trim(),
      ).toBe(text);
      expect(calls).toEqual([]);
      await expect(page.getByRole('button', { name: '继续阅读' })).toHaveCount(0);
      await request.delete(`/api/shares/${preview.share.id}`, { headers });
      await page.reload();
      await expect(page.getByRole('alert')).toContainText('链接不可用');
      await expect(page.getByTestId('assistant-message')).toHaveCount(0);
    } finally {
      await anonymous.close();
    }
    expect(
      (
        await request.get(path, {
          headers: { 'If-None-Match': preview.share.hash },
        })
      ).status(),
    ).toBe(404);
    await request.delete(`/api/conversations/${id}`, { headers });
  } finally {
    await request.put('/api/settings/providers', { headers, data: previous });
  }
});
