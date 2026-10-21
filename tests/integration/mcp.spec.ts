import { expect, test, type APIRequestContext } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ProviderSettings } from '../../shared/providers/types';
import type { ModelsResult, RunResult } from '../../worker/mcp/contracts';
import { openSpaceSettings } from '../support/browser/ui';

const origin = 'http://127.0.0.1:5174',
  headers = { Origin: origin };
const path = '/api/settings/mcp/keys';
async function setup(request: APIRequestContext) {
  await request.post('/__dev/access/login');
  const initial: ProviderSettings = await request
    .get('/api/settings/providers')
    .then((response) => response.json());
  const providers = (['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const).map(
    (provider) => ({
      id: crypto.randomUUID(),
      name: provider,
      provider,
      baseUrl: 'https://provider.test/v1',
      apiKey: 'integration-test-key',
      models: [
        {
          id: 'mcp-fixture',
          name: 'MCP test model',
          enabled: true,
          reasoningSupport: 'supported',
          metadataOverrides: { contextWindow: 100_000, maxOutputTokens: 8192 },
        },
      ],
    }),
  );
  expect(
    (
      await request.put('/api/settings/providers', {
        headers,
        data: {
          ...initial,
          providers,
          activeProviderId: providers[0].id,
          activeModel: 'mcp-fixture',
        },
      })
    ).ok(),
  ).toBe(true);
  const keys: string[] = [],
    conversations = new Set<string>(),
    clients: Client[] = [];
  return {
    providers,
    async client(mode: 'auto' | 'legacy' = 'auto') {
      const created = (await request
        .post(path, { headers, data: { name: `test-${mode}` } })
        .then((response) => response.json())) as { id: string; key: string };
      keys.push(created.id);
      const client = new Client(
        { name: 'everchat-integration', version: '1.0.0' },
        { versionNegotiation: { mode } },
      );
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL('/mcp', origin), {
          requestInit: { headers: { Authorization: `Bearer ${created.key}` } },
        }),
      );
      return { client, ...created };
    },
    async call<T>(client: Client, name: string, arguments_: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: arguments_ });
      if (
        result.structuredContent &&
        typeof result.structuredContent === 'object' &&
        'conversationId' in result.structuredContent
      )
        conversations.add(String(result.structuredContent.conversationId));
      return result.structuredContent as T;
    },
    async cleanup() {
      for (const client of clients) await client.close().catch(() => {});
      for (const id of keys) await request.delete(`${path}/${id}`, { headers });
      for (const id of conversations) await request.delete(`/api/conversations/${id}`, { headers });
      await request.put('/api/settings/providers', { headers, data: initial });
    },
  };
}

test('MCP modern and legacy clients share the four-tool contract and all provider protocols save normal conversations', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    for (const mode of ['auto', 'legacy'] as const) {
      const { client } = await app.client(mode);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name).sort()).toEqual([
        'everchat_chat',
        'everchat_models_list',
        'everchat_run_cancel',
        'everchat_run_get',
      ]);
      for (const tool of tools.tools) expect(tool.outputSchema).toBeTruthy();
      const catalog = await app.call<ModelsResult>(client, 'everchat_models_list');
      expect(catalog.models).toHaveLength(4);
      expect(JSON.stringify(catalog)).not.toMatch(
        /provider\.test|integration-test-key|baseUrl|apiKey/,
      );
      for (const model of mode === 'auto' ? catalog.models : catalog.models.slice(0, 1)) {
        const run = await app.call<RunResult>(client, 'everchat_chat', {
          requestId: crypto.randomUUID(),
          modelRef: model.ref,
          prompt: 'MCP protocol check',
          waitMs: 10_000,
        });
        expect(run.status).toBe('completed');
        expect(run.output.text).toContain('正文');
        expect(run.continuation).toBeTruthy();
        const detailed = await app.call<RunResult>(client, 'everchat_run_get', {
          runRef: run.runRef,
          includeReasoning: true,
          waitMs: 0,
        });
        expect(detailed.reasoning?.text).toContain('思考');
        const normal = await request
          .get(`/api/conversations/${run.conversationId}/backup`)
          .then((response) => response.json());
        expect(JSON.stringify(normal)).toContain('MCP protocol check');
      }
    }
  } finally {
    await app.cleanup();
  }
});

test('MCP retries, continuation, cancellation and API key isolation are enforced by the real durable runtime', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    const one = await app.client(),
      two = await app.client();
    const catalog = await app.call<ModelsResult>(one.client, 'everchat_models_list');
    const args = {
      requestId: crypto.randomUUID(),
      modelRef: catalog.models[0].ref,
      prompt: 'MCP idempotency check',
      waitMs: 0,
    };
    const first = await app.call<RunResult>(one.client, 'everchat_chat', args);
    const repeat = await app.call<RunResult>(one.client, 'everchat_chat', {
      ...args,
      waitMs: 10_000,
    });
    expect(repeat.runRef).toBe(first.runRef);
    expect(repeat.assistantMessageId).toBe(first.assistantMessageId);
    expect(repeat.status).toBe('completed');
    const conflict = await one.client.callTool({
      name: 'everchat_chat',
      arguments: { ...args, prompt: 'different' },
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    for (const name of ['everchat_run_get', 'everchat_run_cancel']) {
      const denied = await two.client.callTool({
        name,
        arguments: { runRef: first.runRef, ...(name === 'everchat_run_get' ? { waitMs: 0 } : {}) },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({ error: { code: 'RUN_NOT_FOUND' } });
    }
    const continued = await app.call<RunResult>(one.client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      continuation: repeat.continuation!,
      prompt: 'Continue exactly here',
      waitMs: 10_000,
    });
    expect(continued.status).toBe('completed');
    expect(continued.conversationId).toBe(first.conversationId);
    expect(continued.model.ref).toBe(first.model.ref);
    const ended = await app.call<RunResult>(one.client, 'everchat_run_cancel', {
      runRef: continued.runRef,
    });
    expect(ended.status).toBe('completed');
    await request.delete(`${path}/${one.id}`, { headers });
    await expect(one.client.listTools()).rejects.toThrow();
    expect((await app.call<ModelsResult>(two.client, 'everchat_models_list')).models).toHaveLength(
      4,
    );
    const raw = await request.post('/mcp', {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: {
        Authorization: `Bearer ${two.key}`,
        Origin: 'https://evil.example',
        Accept: 'application/json, text/event-stream',
      },
    });
    expect(raw.status()).toBe(403);
    expect((await request.get('/mcp')).status()).toBe(401);
    const privateWithoutCookie = await fetch(`${origin}${path}`, {
      headers: { Authorization: `Bearer ${two.key}` },
    });
    expect(privateWithoutCookie.status).toBe(401);
  } finally {
    await app.cleanup();
  }
});

test('MCP handles independent parallel runs, busy conversations, active cancellation, interrupted continuation and complete output pagination', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    const profiles = app.providers.map((provider, index) =>
      index
        ? provider
        : {
            ...provider,
            models: [
              ...provider.models,
              ...['usage-partial-cancel', 'mcp-long-fixture', 'diagnostic-disconnect'].map(
                (id) => ({ ...provider.models[0], id }),
              ),
            ],
          },
    );
    const current = await request
      .get('/api/settings/providers')
      .then((response) => response.json());
    expect(
      (
        await request.put('/api/settings/providers', {
          headers,
          data: { ...current, providers: profiles },
        })
      ).ok(),
    ).toBe(true);
    const { client } = await app.client();
    const catalog = await app.call<ModelsResult>(client, 'everchat_models_list');
    const model = (id: string) => catalog.models.find((item) => item.id === id)!.ref;
    const [root, parallel] = await Promise.all(
      [0, 1].map(() =>
        app.call<RunResult>(client, 'everchat_chat', {
          requestId: crypto.randomUUID(),
          prompt: 'Parallel MCP',
          modelRef: model('mcp-fixture'),
          waitMs: 10_000,
        }),
      ),
    );
    expect(root.conversationId).not.toBe(parallel.conversationId);
    const active = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      continuation: root.continuation!,
      prompt: 'Slow answer',
      modelRef: model('usage-partial-cancel'),
      waitMs: 2000,
    });
    expect(active.status).toBe('running');
    const busy = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      continuation: root.continuation!,
      prompt: 'Competing answer',
      waitMs: 0,
    });
    expect(busy).toMatchObject({ status: 'failed', error: { code: 'CONVERSATION_BUSY' } });
    const cancelled = await app.call<RunResult>(client, 'everchat_run_cancel', {
      runRef: active.runRef,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.output.text).toContain('已报告部分用量');
    const interrupted = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      modelRef: model('diagnostic-disconnect'),
      prompt: 'Retain partial output',
      waitMs: 10_000,
    });
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.output.text).toContain('正文');
    const resumed = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      continuation: interrupted.continuation!,
      modelRef: model('mcp-fixture'),
      prompt: 'Use that partial answer',
      waitMs: 10_000,
    });
    expect(resumed.status).toBe('completed');
    const long = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      modelRef: model('mcp-long-fixture'),
      prompt: 'Long output',
      waitMs: 10_000,
    });
    let page = long,
      text = page.output.text;
    expect(page.output.hasMore).toBe(true);
    while (page.output.hasMore) {
      page = await app.call<RunResult>(client, 'everchat_run_get', {
        runRef: long.runRef,
        outputCursor: page.output.nextCursor,
        waitMs: 0,
      });
      text += page.output.text;
    }
    expect(text).toBe('START\n' + '0123456789🙂正文\n'.repeat(2400) + '\nEND');
    const detail = await app.call<RunResult>(client, 'everchat_run_get', {
      runRef: long.runRef,
      includeReasoning: true,
      waitMs: 0,
    });
    expect(detail.reasoning?.hasMore).toBe(true);
    let reasoning = detail.reasoning!.text,
      cursor = detail.reasoning!.nextCursor;
    while (cursor) {
      const next = await app.call<RunResult>(client, 'everchat_run_get', {
        runRef: long.runRef,
        includeReasoning: true,
        reasoningCursor: cursor,
        waitMs: 0,
      });
      reasoning += next.reasoning!.text;
      cursor = next.reasoning!.nextCursor;
    }
    expect(reasoning).toBe('思考🧠'.repeat(3000));
  } finally {
    await app.cleanup();
  }
});

for (const mobile of [false, true]) {
  test(`MCP key management ${mobile ? 'mobile dark' : 'desktop light'} creates, renames and deletes without exposing saved secrets`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: mobile ? 'dark' : 'light' });
    await page.request.post('/__dev/access/login');
    await page.goto('/');
    await openSpaceSettings(page);
    await page.getByRole('tab', { name: 'MCP', exact: true }).click();
    let name = `UI MCP ${crypto.randomUUID()}`;
    const panel = page.locator('#settings-panel-mcp');
    await panel.getByRole('button', { name: '创建 API 密钥', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '创建 API 密钥', exact: true });
    await expect(editor.getByLabel('密钥名称', { exact: true })).toBeFocused();
    await expect(editor.getByRole('button', { name: '创建 API 密钥', exact: true })).toBeDisabled();
    await editor.getByLabel('密钥名称', { exact: true }).fill(name);
    await editor.getByRole('button', { name: '创建 API 密钥', exact: true }).click();
    const created = page.getByRole('dialog', { name: 'API 密钥已创建', exact: true });
    const secret = await created.getByLabel('新 API 密钥', { exact: true }).inputValue();
    expect(secret).toMatch(/^ec_mcp_/);
    const list = await page.request.get(path).then((response) => response.json());
    const key = list.keys.find((key: { name: string }) => key.name === name);
    try {
      expect(
        await page.evaluate((value) => JSON.stringify(localStorage).includes(value), secret),
      ).toBe(false);
      expect(JSON.stringify(list)).not.toContain(secret);
      expect(key).toMatchObject({ keyHint: `ec_mcp_••••${secret.slice(-6)}`, lastUsedAt: null });
      await created.getByRole('button', { name: '已保存', exact: true }).click();
      await expect(page.getByLabel('新 API 密钥', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('Tracking ID', { exact: true })).toHaveCount(0);
      await expect(
        panel.getByText(key.keyHint, { exact: true }).filter({ visible: true }),
      ).toBeVisible();
      await panel.getByRole('button', { name: `重命名 ${name}`, exact: true }).click();
      const rename = page.getByRole('dialog', { name: '重命名', exact: true });
      name += ' renamed';
      await rename.getByLabel('密钥名称', { exact: true }).fill(name);
      await rename.getByRole('button', { name: '保存', exact: true }).click();
      await expect(rename).toBeHidden();
      await expect(
        panel.getByRole('button', { name: `重命名 ${name}`, exact: true }),
      ).toBeVisible();
      expect(
        (await page.request.patch(`${path}/${key.id}`, { headers, data: { name: '  ' } })).status(),
      ).toBe(400);
      // Renaming changes only metadata; the original credential remains usable.
      expect(
        (
          await fetch(`${origin}/mcp`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${secret}`,
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          })
        ).status,
      ).toBe(200);
      const used = await page.request.get(path).then((response) => response.json());
      expect(
        used.keys.find((item: { id: string }) => item.id === key.id).lastUsedAt,
      ).toBeGreaterThan(0);
      await expect(page.locator('[data-slot="dialog-content"][data-ending-style]')).toHaveCount(0);
      await page.screenshot({
        path: `/tmp/everchat-mcp-settings-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
      });
      const layout = await panel.evaluate((element) => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowing: [...element.querySelectorAll('*')]
          .filter((child) => child.scrollWidth > child.clientWidth + 1)
          .slice(0, 6)
          .map((child) => [child.tagName, child.className, child.clientWidth, child.scrollWidth]),
      }));
      expect(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout)).toBe(true);
      await panel.getByRole('button', { name: `删除 ${name}`, exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: '删除 API 密钥？' });
      await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
      await confirmation.getByRole('button', { name: '取消', exact: true }).click();
      expect(
        (await page.request.get(path).then((response) => response.json())).keys.some(
          (item: { id: string }) => item.id === key.id,
        ),
      ).toBe(true);
      await panel.getByRole('button', { name: `删除 ${name}`, exact: true }).click();
      await confirmation.getByRole('button', { name: '删除', exact: true }).click();
      await expect(confirmation).toBeHidden();
      await expect(panel.getByRole('button', { name: `删除 ${name}`, exact: true })).toHaveCount(0);
      const response = await fetch(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(response.status).toBe(401);
    } finally {
      await page.request.delete(`${path}/${key.id}`, { headers });
    }
  });
}
