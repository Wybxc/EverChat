import { expect, test, type APIRequestContext } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ProviderSettings } from '../../shared/providers/types';
import type { HelpResult, ModelsResult, RunResult } from '../../worker/mcp/contracts';
import { openSpaceSettings } from '../support/browser/ui';
import { createHash } from 'node:crypto';
import { documentPrompt } from '../../shared/attachments/documents';
import type { AttachmentsResult } from '../../worker/mcp/attachment-contracts';
import { encodeRef } from '../../worker/mcp/contracts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { uploadFiles } from '../../scripts/mcp/upload';
import { textPdf } from '../support/assets/pdf';

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
        .then((response) => response.json())) as { id: string; key: string; name: string };
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

test('MCP answer continuation creates composed sibling versions across all protocols without changing normal follow-up semantics', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    const { client } = await app.client();
    const catalog = await app.call<ModelsResult>(client, 'everchat_models_list');
    for (const model of catalog.models) {
      const first = await app.call<RunResult>(client, 'everchat_chat', {
        requestId: crypto.randomUUID(),
        modelRef: model.ref,
        prompt: 'A background question',
        waitMs: 20_000,
      });
      expect(first.status).toBe('completed');
      const continued = await app.call<RunResult>(client, 'everchat_chat', {
        requestId: crypto.randomUUID(),
        continuation: first.continuation,
        continueAnswer: true,
        waitMs: 20_000,
      });
      expect(continued.status).toBe('completed');
      expect(continued.continuedFrom).toBe(first.assistantMessageId);
      expect(continued.output.text.startsWith(first.output.text)).toBe(true);
      expect(continued.output.text.length).toBeGreaterThan(first.output.text.length);
      const ordinary = await app.call<RunResult>(client, 'everchat_chat', {
        requestId: crypto.randomUUID(),
        continuation: continued.continuation,
        prompt: 'A normal new question',
        waitMs: 20_000,
      });
      expect(ordinary.status).toBe('completed');
      expect(ordinary.continuedFrom).toBeUndefined();
      const state = await request
        .get(`/api/conversations/${first.conversationId}`)
        .then((r) => r.json());
      const source = state.messages.find((m: { id: string }) => m.id === first.assistantMessageId);
      const combined = state.messages.find(
        (m: { id: string }) => m.id === continued.assistantMessageId,
      );
      expect(combined.parentId).toBe(source.parentId);
      expect(combined.revisionOf).toBe(source.id);
      expect(state.messages.filter((m: { role: string }) => m.role === 'user')).toHaveLength(2);
      const receipt = await app.call<import('../../worker/mcp/contracts').ContextResult>(
        client,
        'everchat_run_context_get',
        { runRef: continued.runRef },
      );
      const sourceInput = receipt.items.find((item) => item.sourceId === first.assistantMessageId)!;
      const controlInput = receipt.items.find(
        (item) => item.kind === 'generated' && item.role === 'user',
      )!;
      expect(sourceInput).toBeTruthy();
      const control = await app.call<import('../../worker/mcp/contracts').ContextResult>(
        client,
        'everchat_run_context_get',
        { runRef: continued.runRef, view: 'text', item: controlInput.ordinal },
      );
      expect(control.text?.text).toBe('继续');
      await request.delete(`/api/conversations/${first.conversationId}/messages/${source.id}`, {
        headers,
      });
      const sourceText = await app.call<import('../../worker/mcp/contracts').ContextResult>(
        client,
        'everchat_run_context_get',
        { runRef: continued.runRef, view: 'text', item: sourceInput.ordinal },
      );
      expect(sourceText.text).toEqual({ state: 'available', text: first.output.text });
    }
  } finally {
    await app.cleanup();
  }
});

test('MCP modern and legacy clients share the tool contract and all provider protocols save normal conversations', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    for (const mode of ['auto', 'legacy'] as const) {
      const { client } = await app.client(mode);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name).sort()).toEqual([
        'everchat_attachments_delete',
        'everchat_attachments_get',
        'everchat_attachments_prepare',
        'everchat_attachments_put',
        'everchat_chat',
        'everchat_conversation_export',
        'everchat_conversation_read',
        'everchat_conversations_list',
        'everchat_help',
        'everchat_models_list',
        'everchat_run_cancel',
        'everchat_run_context_get',
        'everchat_run_get',
        'everchat_run_usage_get',
      ]);
      for (const tool of tools.tools) expect(tool.outputSchema).toBeTruthy();
      const help = await app.call<HelpResult>(client, 'everchat_help');
      expect(help.tools.map(({ name }) => name).sort()).toEqual(
        tools.tools.map(({ name }) => name).sort(),
      );
      for (const tool of help.tools)
        expect(tool.inputSchema).toEqual(
          tools.tools.find(({ name }) => name === tool.name)!.inputSchema,
        );
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
        expect(run.completion).toMatchObject({ state: 'complete', truncated: false });
        expect(run.progress?.providerRequestedAt).toBeGreaterThan(0);
        expect(run.progress?.phase).toBeNull();
        expect(run.output.text).toContain('正文');
        expect(run.continuation).toBeTruthy();
        expect(run.context).toMatchObject({
          state: 'submission_attempted',
          steps: 1,
          providerReceipt: 'not_proven',
        });
        const receipt = await app.call<import('../../worker/mcp/contracts').ContextResult>(
          client,
          'everchat_run_context_get',
          { runRef: run.runRef },
        );
        expect(receipt.receipt?.requestSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(receipt.receipt?.estimatedInputTokens).toBeGreaterThan(0);
        expect(receipt.receipt?.parameterEvidence).toBe('application_requested');
        const current = receipt.items.find((item) => item.kind === 'message')!;
        expect(current.sourceId).toBeTruthy();
        const inputText = await app.call<import('../../worker/mcp/contracts').ContextResult>(
          client,
          'everchat_run_context_get',
          {
            runRef: run.runRef,
            view: 'text',
            step: 0,
            item: current.ordinal,
          },
        );
        expect(inputText.text).toEqual({ state: 'available', text: 'MCP protocol check' });
        expect(run.usage.inputTokens).toBeGreaterThan(0);
        expect(run.usage.finalized).toBe(true);
        expect(run.usage.dimensions.inputTokens.reportedSteps).toBe(1);
        await expect
          .poll(async () => {
            const usage = await app.call<import('../../worker/mcp/contracts').UsageResult>(
              client,
              'everchat_run_usage_get',
              { runRef: run.runRef },
            );
            expect(usage.scope).toBe('answer_model_steps');
            expect(JSON.stringify(usage)).not.toMatch(/integration-test-key|baseUrl|apiKey/);
            return usage.observedAttempts;
          })
          .toBe(1);
        const costs = await app.call<import('../../worker/mcp/contracts').UsageResult>(
          client,
          'everchat_run_usage_get',
          { runRef: run.runRef, view: 'costs' },
        );
        expect(costs.accounting).toBe('ready');
        expect(costs.costs).toEqual([
          expect.objectContaining({
            kind: 'chat',
            includedInAnswer: true,
            attempts: 1,
            amount: null,
            state: 'unpriced',
          }),
        ]);
        expect(costs.excludedCosts.map((c) => c.kind)).toEqual(['title', 'summary']);
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

test('MCP on-demand HTML tools return manifest and submitted fragment evidence across all protocols', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    const current = await (await request.get('/api/settings/providers')).json();
    const providers = app.providers.map((provider) => ({
      ...provider,
      models: [
        {
          ...provider.models[0],
          id: `tools-attachment-${provider.provider}`,
          metadataOverrides: { ...provider.models[0].metadataOverrides, toolCalls: true },
        },
      ],
    }));
    expect(
      (
        await request.put('/api/settings/providers', {
          headers,
          data: { ...current, providers, activeModel: providers[0].models[0].id },
        })
      ).ok(),
    ).toBe(true);
    const { client } = await app.client(),
      catalog = await app.call<ModelsResult>(client, 'everchat_models_list');
    for (const model of catalog.models) {
      const text = '<html>\n' + '背景材料\n'.repeat(100000) + '模型应读到这里🙂\n</html>';
      const saved = await app.call<AttachmentsResult>(client, 'everchat_attachments_put', {
        uploadId: crypto.randomUUID(),
        files: [
          {
            clientFileId: crypto.randomUUID(),
            name: 'reference.html',
            purpose: 'document',
            mediaType: 'text/html',
            text,
          },
        ],
      });
      expect(saved.files[0].inputStatus).toBe('ready');
      const run = await app.call<RunResult>(client, 'everchat_chat', {
        requestId: crypto.randomUUID(),
        modelRef: model.ref,
        uploadRef: saved.uploadRef,
        attachments: [{ attachmentRef: saved.files[0].attachmentRef, inputMode: 'on_demand' }],
        prompt: '定位并读取目标段落',
        waitMs: 10000,
      });
      expect(run.status, JSON.stringify(run)).toBe('completed');
      expect(run.output.text).toContain('已按需读取附件');
      const receipt = await app.call<import('../../worker/mcp/contracts').ContextResult>(
        client,
        'everchat_run_context_get',
        { runRef: run.runRef },
      );
      const manifest = receipt.items.find((item) => item.kind === 'document')!;
      expect(manifest.attachment).toMatchObject({
        delivery: 'manifest_only',
        contentRead: false,
        verification: 'manifest_metadata_verified',
      });
      const content = await app.call<import('../../worker/mcp/contracts').ContextResult>(
        client,
        'everchat_run_context_get',
        { runRef: run.runRef, view: 'text', item: manifest.ordinal },
      );
      expect(content.text?.text).toContain('Not yet read');
      expect(content.text?.text).not.toContain('模型应读到这里');
      const items = [...receipt.items];
      let next = receipt.nextCursor;
      while (next) {
        const page = await app.call<import('../../worker/mcp/contracts').ContextResult>(
          client,
          'everchat_run_context_get',
          { runRef: run.runRef, cursor: next },
        );
        items.push(...page.items);
        next = page.nextCursor;
      }
      expect(items.filter((item) => item.kind === 'tool')).toHaveLength(2);
    }
  } finally {
    await app.cleanup();
  }
});

test('MCP actual files use immutable key-owned batches, exact input receipts and replay-safe file-only chat', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    const { client, key } = await app.client(),
      other = await app.client();
    const catalog = await app.call<ModelsResult>(client, 'everchat_models_list');
    const text = '= 定义🙂\n重要约束与反例\n'.repeat(1200);
    for (const model of catalog.models) {
      const args = {
        uploadId: crypto.randomUUID(),
        files: [
          {
            clientFileId: crypto.randomUUID(),
            name: '1021.typ',
            mediaType: 'text/plain',
            purpose: 'document',
            text,
          },
        ],
      };
      const saved = await app.call<AttachmentsResult>(client, 'everchat_attachments_put', args);
      expect(saved.files[0]).toMatchObject({
        inputStatus: 'ready',
        sha256: createHash('sha256').update(text).digest('hex'),
      });
      expect(await app.call<AttachmentsResult>(client, 'everchat_attachments_put', args)).toEqual(
        saved,
      );
      const denied = await app.call<{ error: { code: string } }>(
        other.client,
        'everchat_attachments_get',
        { uploadRef: saved.uploadRef },
      );
      expect(denied.error.code).toBe('UPLOAD_UNAVAILABLE');
      const input = {
        requestId: crypto.randomUUID(),
        modelRef: model.ref,
        prompt: '',
        uploadRef: saved.uploadRef,
        attachments: [{ attachmentRef: saved.files[0].attachmentRef, inputMode: 'inline' }],
        waitMs: 10_000,
      };
      const run = await app.call<RunResult>(client, 'everchat_chat', input);
      expect(run.status, JSON.stringify(run)).toBe('completed');
      expect(run.conversationId).toBe(saved.conversationId);
      expect((await app.call<RunResult>(client, 'everchat_chat', input)).runRef).toBe(run.runRef);
      const manifest = await app.call<import('../../worker/mcp/contracts').ContextResult>(
        client,
        'everchat_run_context_get',
        { runRef: run.runRef },
      );
      const file = manifest.items.find((i) => i.kind === 'document')!;
      expect(file.content).toBe('document_snapshot');
      let page = await app.call<import('../../worker/mcp/contracts').ContextResult>(
          client,
          'everchat_run_context_get',
          { runRef: run.runRef, view: 'text', item: file.ordinal },
        ),
        actual = page.text!.text;
      expect(page.textUnit).toBe('utf8_bytes');
      while (page.hasMore) {
        page = await app.call(client, 'everchat_run_context_get', {
          runRef: run.runRef,
          view: 'text',
          item: file.ordinal,
          cursor: page.nextCursor,
        });
        actual += page.text!.text;
      }
      expect(actual).toBe(documentPrompt({ name: '1021.typ', mediaType: 'text/plain' }, text));
      const preview = await app.call<AttachmentsResult>(client, 'everchat_attachments_get', {
        attachmentRef: saved.files[0].attachmentRef,
        view: 'text',
      });
      expect(preview.text).toContain('定义');
      expect(preview.hasMore).toBe(true);
      const blocked = await app.call<{ files: { deleted: boolean; error: { message: string } }[] }>(
        client,
        'everchat_attachments_delete',
        { attachmentRefs: [saved.files[0].attachmentRef] },
      );
      expect(blocked.files[0].deleted).toBe(false);
      const download = await fetch(`${origin}/mcp/attachments/${saved.files[0].attachmentRef}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      expect(download.status).toBe(200);
      expect(await download.text()).toBe(text);
      expect(
        (await fetch(`${origin}/mcp/attachments/${saved.files[0].attachmentRef}`)).status,
      ).toBe(401);
      const reused = await app.call<{ error: { code: string } }>(client, 'everchat_chat', {
        ...input,
        requestId: crypto.randomUUID(),
      });
      expect(reused.error.code).toBe('UPLOAD_ALREADY_USED');
    }
  } finally {
    await app.cleanup();
  }
});

test('MCP material versions replace only the selected branch, remain pinned and preserve old input receipts', async ({
  request,
}) => {
  test.slow();
  const app = await setup(request);
  try {
    const { client } = await app.client(),
      catalog = await app.call<ModelsResult>(client, 'everchat_models_list');
    for (const model of catalog.models) {
      const upload = async (text: string, continuation?: string, replaces?: string) =>
        app.call<AttachmentsResult>(client, 'everchat_attachments_put', {
          uploadId: crypto.randomUUID(),
          ...(continuation ? { continuation } : {}),
          files: [
            {
              clientFileId: crypto.randomUUID(),
              name: '1021.typ',
              mediaType: 'text/plain',
              purpose: 'document',
              text,
              ...(replaces ? { replaces } : {}),
              versionNote: text,
            },
          ],
        });
      const first = await upload('VERSION_ONE_DEFINITION'),
        root = await app.call<RunResult>(client, 'everchat_chat', {
          requestId: crypto.randomUUID(),
          prompt: 'Original',
          modelRef: model.ref,
          uploadRef: first.uploadRef,
          attachments: [{ attachmentRef: first.files[0].attachmentRef }],
          waitMs: 10000,
        });
      expect(root.status).toBe('completed');
      const second = await upload(
        'VERSION_TWO_DEFINITION',
        root.continuation!,
        first.files[0].attachmentRef,
      );
      expect(second.files[0].documentRef).toBe(first.files[0].documentRef);
      expect(second.files[0].versionRef).not.toBe(first.files[0].versionRef);
      const replacement = await app.call<RunResult>(client, 'everchat_chat', {
        requestId: crypto.randomUUID(),
        prompt: 'Replace',
        continuation: root.continuation,
        modelRef: model.ref,
        uploadRef: second.uploadRef,
        attachments: [{ attachmentRef: second.files[0].attachmentRef, mode: 'replace' }],
        waitMs: 10000,
        recentMessages: 1,
      });
      expect(replacement.status, JSON.stringify(replacement)).toBe('completed');
      const manifests = async (run: RunResult) => {
        let page = await app.call<import('../../worker/mcp/contracts').ContextResult>(
            client,
            'everchat_run_context_get',
            { runRef: run.runRef },
          ),
          items = page.items;
        while (page.hasMore) {
          page = await app.call(client, 'everchat_run_context_get', {
            runRef: run.runRef,
            cursor: page.nextCursor,
          });
          items.push(...page.items);
        }
        return items.filter((i) => i.kind === 'document');
      };
      expect((await manifests(replacement)).map((i) => i.attachment!.attachmentId)).toEqual([
        second.files[0].parsed!.attachmentId,
      ]);
      const omissions = await app.call<import('../../worker/mcp/contracts').ContextResult>(
        client,
        'everchat_run_context_get',
        { runRef: replacement.runRef, view: 'exclusions' },
      );
      expect(omissions.exclusions).toContainEqual(
        expect.objectContaining({
          reason: 'superseded_file',
          file: expect.objectContaining({ attachmentId: first.files[0].parsed!.attachmentId }),
        }),
      );
      expect((await manifests(root)).map((i) => i.attachment!.attachmentId)).toEqual([
        first.files[0].parsed!.attachmentId,
      ]);
      const next = await app.call<RunResult>(client, 'everchat_chat', {
        requestId: crypto.randomUUID(),
        prompt: 'Next',
        continuation: replacement.continuation,
        waitMs: 10000,
      });
      expect(next.status).toBe('completed');
      expect((await manifests(next)).map((i) => i.attachment!.attachmentId)).toEqual([
        second.files[0].parsed!.attachmentId,
      ]);
      const sibling = await app.call<RunResult>(client, 'everchat_chat', {
        requestId: crypto.randomUUID(),
        prompt: 'Sibling',
        continuation: root.continuation,
        waitMs: 10000,
        recentMessages: 1,
      });
      expect(sibling.status).toBe('completed');
      expect((await manifests(sibling)).map((i) => i.attachment!.attachmentId)).toEqual([
        first.files[0].parsed!.attachmentId,
      ]);
      const both = await app.call<RunResult>(client, 'everchat_chat', {
        requestId: crypto.randomUUID(),
        prompt: 'Compare',
        continuation: replacement.continuation,
        attachments: [{ attachmentRef: first.files[0].attachmentRef, mode: 'include_both' }],
        waitMs: 10000,
      });
      expect(both.status, JSON.stringify(both)).toBe('completed');
      expect((await manifests(both)).length).toBe(2);
    }
  } finally {
    await app.cleanup();
  }
});

test('MCP R2 direct files need no confirmation and unready uploads can retry the original requestId', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    const { client } = await app.client(),
      catalog = await app.call<ModelsResult>(client, 'everchat_models_list');
    const bytes = Buffer.from('实际文件🙂 Budget: 42'),
      args = {
        uploadId: crypto.randomUUID(),
        files: [
          {
            clientFileId: crypto.randomUUID(),
            name: 'notes.md',
            mediaType: 'text/markdown',
            purpose: 'document',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      };
    const saved = await app.call<AttachmentsResult>(client, 'everchat_attachments_prepare', args);
    expect(saved.files[0].uploads).toHaveLength(1);
    const input = {
      requestId: crypto.randomUUID(),
      modelRef: catalog.models[0].ref,
      prompt: 'Explain',
      uploadRef: saved.uploadRef,
      attachments: [{ attachmentRef: saved.files[0].attachmentRef }],
      waitMs: 10_000,
    };
    const pending = await app.call<{ error: { code: string } }>(client, 'everchat_chat', input);
    expect(pending.error).toBeTruthy();
    const target = saved.files[0].uploads[0];
    const uploaded = await request.put(target.url, { headers: target.headers, data: bytes });
    expect(uploaded.status(), await uploaded.text()).toBe(200);
    const observed = await app.call<AttachmentsResult>(client, 'everchat_attachments_get', {
      uploadRef: saved.uploadRef,
    });
    expect(observed.files[0].uploadStatus).toBe('registered');
    expect(observed.files[0].inputStatus).toBe('preparing');
    const run = await app.call<RunResult>(client, 'everchat_chat', input);
    expect(run.status, JSON.stringify(run)).toBe('completed');
    expect((await request.put(target.url, { headers: target.headers, data: bytes })).status()).toBe(
      412,
    );
  } finally {
    await app.cleanup();
  }
});

test('MCP local upload helper sends PDF and paginated batches directly, preserving retry identities without a confirmation step', async ({
  request,
}) => {
  const app = await setup(request),
    directory = await mkdtemp(join(tmpdir(), 'everchat-mcp-helper-')),
    oldKey = process.env.EVERCHAT_API_KEY,
    oldUrl = process.env.EVERCHAT_MCP_URL;
  try {
    const { client, key } = await app.client(),
      catalog = await app.call<ModelsResult>(client, 'everchat_models_list');
    process.env.EVERCHAT_API_KEY = key;
    process.env.EVERCHAT_MCP_URL = origin + '/mcp';
    const pdf = join(directory, 'paper.pdf'),
      notes = join(directory, '1021.typ'),
      manifest = join(directory, 'manifest.json'),
      state = join(directory, 'state.json');
    await writeFile(pdf, textPdf([['First page definition.'], ['Second page evidence.']]));
    await writeFile(notes, '= Versioned source');
    await writeFile(
      manifest,
      JSON.stringify({
        files: [
          { path: pdf },
          ...Array.from({ length: 16 }, () => ({ path: notes, versionNote: '🙂'.repeat(500) })),
        ],
      }),
    );
    const uploaded = await uploadFiles(manifest, state);
    expect(uploaded.files).toHaveLength(17);
    expect(await uploadFiles(manifest, state)).toEqual(uploaded);
    const run = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      modelRef: catalog.models[0].ref,
      prompt: 'Use page two',
      uploadRef: uploaded.uploadRef,
      attachments: [
        {
          attachmentRef: uploaded.files[0].attachmentRef,
          selection: { pageRanges: [{ start: 2, end: 2 }] },
        },
      ],
      waitMs: 10000,
    });
    expect(run.status, JSON.stringify(run)).toBe('completed');
    const receipt = await app.call<import('../../worker/mcp/contracts').ContextResult>(
        client,
        'everchat_run_context_get',
        { runRef: run.runRef },
      ),
      file = receipt.items.find((i) => i.kind === 'document')!;
    const actual = await app.call<import('../../worker/mcp/contracts').ContextResult>(
      client,
      'everchat_run_context_get',
      { runRef: run.runRef, view: 'text', item: file.ordinal },
    );
    expect(actual.text!.text).toContain('Second page evidence.');
    expect(actual.text!.text).not.toContain('First page definition.');
    const deleted = await app.call<{ files: { deleted: boolean }[] }>(
      client,
      'everchat_attachments_delete',
      { attachmentRefs: [uploaded.files[1].attachmentRef] },
    );
    expect(deleted.files[0].deleted).toBe(true);
  } finally {
    if (oldKey === undefined) delete process.env.EVERCHAT_API_KEY;
    else process.env.EVERCHAT_API_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.EVERCHAT_MCP_URL;
    else process.env.EVERCHAT_MCP_URL = oldUrl;
    await app.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP independent proposals and reviews use verified whitelists, visible snapshots and exact quotes', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    const { client } = await app.client(),
      other = await app.client(),
      catalog = await app.call<ModelsResult>(client, 'everchat_models_list');
    const original = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      modelRef: catalog.models[0].ref,
      prompt: 'Background definition ONLY: 42 units.',
      waitMs: 10000,
    });
    const ref = encodeRef('conversation1', [original.conversationId]);
    let page = await app.call<
      import('valibot').InferOutput<
        typeof import('../../worker/mcp/contracts').conversationReadResultSchema
      >
    >(client, 'everchat_conversation_read', {
      conversationRef: ref,
      headId: original.assistantMessageId,
    });
    const records = [...page.records];
    while (page.hasMore) {
      page = await app.call(client, 'everchat_conversation_read', {
        conversationRef: ref,
        headId: original.assistantMessageId,
        cursor: page.nextCursor,
      });
      records.push(...page.records);
    }
    const citation = (role: string) => {
      const meta = records.find((r) => r.kind === 'message' && r.role === role)!;
      if (meta.kind !== 'message') throw new Error();
      const text = records
        .filter((r) => r.kind === 'text' && r.channel === 'content' && r.messageId === meta.id)
        .map((r) => (r.kind === 'text' ? r.text : ''))
        .join('');
      return {
        messageRef: meta.ref,
        revision: meta.revision,
        sha256: createHash('sha256').update(text).digest('hex'),
      };
    };
    const background = citation('user'),
      target = citation('assistant'),
      args = {
        requestId: crypto.randomUUID(),
        modelRef: catalog.models[0].ref,
        prompt: 'Propose independently',
        discussion: { mode: 'independent', background: [background] },
        waitMs: 10000,
      };
    const independent = await app.call<RunResult>(client, 'everchat_chat', args);
    expect(independent.status, JSON.stringify(independent)).toBe('completed');
    expect(independent.conversationId).not.toBe(original.conversationId);
    const snapshot = await request
      .get(`/api/conversations/${independent.conversationId}`)
      .then((r) => r.json());
    const saved = snapshot.messages.find((m: { role: string }) => m.role === 'user'),
      text = saved.parts
        .filter((p: { type: string }) => p.type === 'text')
        .map((p: { text: string }) => p.text)
        .join('');
    expect(text).toContain('Background definition ONLY');
    expect(text).toContain('explicit_whitelist');
    expect(text).not.toContain(target.messageRef);
    expect(saved.parentId).toBe(null);
    expect((await app.call<RunResult>(client, 'everchat_chat', args)).runRef).toBe(
      independent.runRef,
    );
    const denied = await app.call<{ error: { code: string } }>(other.client, 'everchat_chat', {
      ...args,
      requestId: crypto.randomUUID(),
    });
    expect(denied.error.code).toBe('DISCUSSION_ACCESS_DENIED');
    const invalid = await app.call<{ error: { code: string } }>(client, 'everchat_chat', {
      ...args,
      requestId: crypto.randomUUID(),
      discussion: { mode: 'independent', background: [{ ...background, sha256: '0'.repeat(64) }] },
    });
    expect(invalid.error.code).toBe('SOURCE_CHANGED');
    const review = await app.call<RunResult>(client, 'everchat_chat', {
      ...args,
      requestId: crypto.randomUUID(),
      prompt: 'Review claim C1',
      discussion: {
        mode: 'review',
        background: [background],
        targets: [
          {
            ...target,
            claimId: 'C1',
            range: { start: 0, end: Math.min(8, original.output.text.length) },
            quoteHash: createHash('sha256').update(original.output.text.slice(0, 8)).digest('hex'),
          },
        ],
      },
    });
    expect(review.status, JSON.stringify(review)).toBe('completed');
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
    for (const name of [
      'everchat_run_get',
      'everchat_run_cancel',
      'everchat_run_context_get',
      'everchat_run_usage_get',
    ]) {
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

test('MCP authorized history reads and Markdown exports select one stable branch and never expose another key', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    const owner = await app.client(),
      other = await app.client();
    const catalog = await app.call<ModelsResult>(owner.client, 'everchat_models_list');
    const first = await app.call<RunResult>(owner.client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      modelRef: catalog.models[0].ref,
      prompt: 'History first question',
      waitMs: 10000,
    });
    const second = await app.call<RunResult>(owner.client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      continuation: first.continuation,
      prompt: 'History second question',
      waitMs: 10000,
    });
    const list = await app.call<
      import('valibot').InferOutput<
        typeof import('../../worker/mcp/contracts').conversationListResultSchema
      >
    >(owner.client, 'everchat_conversations_list');
    const item = list.conversations.find((c) => c.id === first.conversationId)!;
    expect(item).toBeTruthy();
    const hidden = await app.call<typeof list>(other.client, 'everchat_conversations_list');
    expect(hidden.conversations.some((c) => c.id === first.conversationId)).toBe(false);
    const unauthorized = await other.client.callTool({
      name: 'everchat_conversation_read',
      arguments: { conversationRef: item.ref, headId: second.assistantMessageId },
    });
    expect(unauthorized.isError).toBe(true);
    expect(unauthorized.structuredContent).toMatchObject({
      error: { code: 'CONVERSATION_UNAVAILABLE' },
    });
    const heads = await app.call<
      import('valibot').InferOutput<
        typeof import('../../worker/mcp/contracts').conversationReadResultSchema
      >
    >(owner.client, 'everchat_conversation_read', { conversationRef: item.ref, view: 'branches' });
    expect(heads.heads.map((h) => h.id)).toContain(second.assistantMessageId);
    const readArgs = {
      conversationRef: item.ref,
      headId: second.assistantMessageId,
      includeReasoning: true,
    };
    const records: typeof heads.records = [];
    let cursor: string | null = null;
    do {
      const page: typeof heads = await app.call<typeof heads>(
        owner.client,
        'everchat_conversation_read',
        {
          ...readArgs,
          ...(cursor ? { cursor } : {}),
        },
      );
      expect(page.revision).toBeGreaterThan(0);
      records.push(...page.records);
      cursor = page.nextCursor;
    } while (cursor);
    expect(records.filter((r) => r.kind === 'message').map((r) => r.round)).toEqual([1, 1, 2, 2]);
    expect(
      records
        .filter((r) => r.kind === 'text' && r.channel === 'content')
        .map((r) => (r.kind === 'text' ? r.text : ''))
        .join(''),
    ).toContain('History first question');
    let markdown = '';
    cursor = null;
    do {
      const page: import('valibot').InferOutput<
        typeof import('../../worker/mcp/contracts').conversationExportResultSchema
      > = await app.call<
        import('valibot').InferOutput<
          typeof import('../../worker/mcp/contracts').conversationExportResultSchema
        >
      >(owner.client, 'everchat_conversation_export', {
        ...readArgs,
        ...(cursor ? { cursor } : {}),
      });
      markdown += page.text;
      cursor = page.nextCursor;
    } while (cursor);
    expect(markdown).toContain('Round 2');
    expect(markdown).toContain('History second question');
    expect(markdown).toContain('MCP test model');
    const start = await app.call<typeof heads>(
      owner.client,
      'everchat_conversation_read',
      readArgs,
    );
    expect(start.nextCursor).toBeTruthy();
    await app.call<RunResult>(owner.client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      continuation: second.continuation,
      prompt: 'advance revision',
      waitMs: 10000,
    });
    const changed = await owner.client.callTool({
      name: 'everchat_conversation_read',
      arguments: { ...readArgs, cursor: start.nextCursor },
    });
    expect(changed.structuredContent).toMatchObject({ error: { code: 'SNAPSHOT_CHANGED' } });
    await request.delete(`${path}/${owner.id}`, { headers });
    expect(
      (
        await owner.client
          .callTool({ name: 'everchat_conversation_read', arguments: readArgs })
          .catch(() => ({ isError: true }))
      ).isError,
    ).toBe(true);
  } finally {
    await app.cleanup();
  }
});

test('MCP effective system prompt receipts require explicit key permission and revocation blocks further reads', async ({
  request,
}) => {
  const app = await setup(request);
  try {
    const owner = await app.client();
    const catalog = await app.call<ModelsResult>(owner.client, 'everchat_models_list');
    const run = async () =>
      app.call<RunResult>(owner.client, 'everchat_chat', {
        requestId: crypto.randomUUID(),
        modelRef: catalog.models[0].ref,
        prompt: 'System receipt check',
        systemPrompt: 'versioned test system prompt',
        waitMs: 10000,
      });
    const first = await run();
    const text = async (ref: string) =>
      app.call<import('../../worker/mcp/contracts').ContextResult>(
        owner.client,
        'everchat_run_context_get',
        { runRef: ref, view: 'text', step: 0, item: 0 },
      );
    expect((await text(first.runRef)).text?.state).toBe('redacted');
    expect(
      (
        await request.patch(`${path}/${owner.id}`, {
          headers,
          data: { name: owner.name, readSystemPrompts: true },
        })
      ).ok(),
    ).toBe(true);
    expect((await text(first.runRef)).text?.state).toBe('redacted');
    const next = await run();
    expect((await text(next.runRef)).text).toEqual({
      state: 'available',
      text: 'versioned test system prompt',
    });
    await request.patch(`${path}/${owner.id}`, {
      headers,
      data: { name: owner.name, readSystemPrompts: false },
    });
    expect((await text(next.runRef)).text?.state).toBe('redacted');
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
              ...[
                'usage-partial-cancel',
                'mcp-long-fixture',
                'mcp-length-fixture',
                'diagnostic-disconnect',
              ].map((id) => ({ ...provider.models[0], id })),
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
    let partial = active;
    await expect
      .poll(async () => {
        partial = await app.call<RunResult>(client, 'everchat_run_get', {
          runRef: active.runRef,
          waitMs: 0,
        });
        return partial.output.text;
      })
      .toContain('已报告部分用量');
    expect(partial.completion).toBeNull();
    expect(partial.progress?.phase).toBe('generating');
    expect(partial.output.contentFinal).toBe(false);
    const prefixCursor = partial.output.resumeCursor!;
    await expect
      .poll(async () => {
        const tail = await app.call<RunResult>(client, 'everchat_run_get', {
          runRef: active.runRef,
          outputCursor: prefixCursor,
          waitMs: 0,
        });
        expect(tail.output.text).not.toContain('已报告部分用量');
        return tail.output.text.length;
      })
      .toBeGreaterThan(0);
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
    expect(cancelled.completion).toMatchObject({ state: 'incomplete', truncated: null });
    expect(cancelled.progress?.phase).toBeNull();
    expect(cancelled.output.text).toContain('已报告部分用量');
    const interrupted = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      modelRef: model('diagnostic-disconnect'),
      prompt: 'Retain partial output',
      waitMs: 10_000,
    });
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.completion).toMatchObject({ state: 'incomplete', truncated: null });
    expect(interrupted.output.text).toContain('正文');
    const resumed = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      continuation: interrupted.continuation!,
      modelRef: model('mcp-fixture'),
      prompt: 'Use that partial answer',
      waitMs: 10_000,
    });
    expect(resumed.status).toBe('completed');
    const limited = await app.call<RunResult>(client, 'everchat_chat', {
      requestId: crypto.randomUUID(),
      modelRef: model('mcp-length-fixture'),
      prompt: 'Length finish',
      waitMs: 10_000,
    });
    expect(limited.status).toBe('completed');
    expect(limited.completion).toMatchObject({
      state: 'incomplete',
      truncated: true,
      reason: 'provider_length_limit',
      requiresNewGeneration: true,
    });
    expect(limited.output.hasMore).toBe(false);
    expect(limited.output.contentFinal).toBe(true);
    expect(limited.continuation).toBeTruthy();
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
    await expect(
      editor.getByRole('checkbox', { name: '允许读取有效系统提示词' }),
    ).not.toBeChecked();
    await expect(editor).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: `/tmp/everchat-mcp-permission-${mobile ? 'mobile-dark' : 'desktop-light'}.png`,
    });
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
      expect(key).toMatchObject({
        keyHint: `ec_mcp_••••${secret.slice(-6)}`,
        lastUsedAt: null,
        readSystemPrompts: false,
      });
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
      await rename.getByRole('checkbox', { name: '允许读取有效系统提示词' }).check();
      await rename.getByRole('button', { name: '保存', exact: true }).click();
      await expect(rename).toBeHidden();
      expect(
        (await page.request.get(path).then((r) => r.json())).keys.find(
          (item: { id: string }) => item.id === key.id,
        ).readSystemPrompts,
      ).toBe(true);
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
