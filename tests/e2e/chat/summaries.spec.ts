import { expect, test, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';
import { validateBackup, type EverChatBackup } from '../../../shared/backup/backup';
import { messageParts, messageText } from '../../../shared/conversation/content';
import { DEFAULT_CONVERSATION_SETTINGS as defaults } from '../../../shared/conversation/settings';
import { SUMMARY_SYSTEM_PROMPT } from '../../../shared/conversation/summaries';
import type {
  ConversationSettings,
  Submission,
  SubmitInput,
} from '../../../shared/conversation/types';
import { modelSelectionKey } from '../../../shared/models/selection';
import type {
  ChatInput,
  ProviderSettings,
  ProviderSettingsInput,
} from '../../../shared/providers/types';
import type { LibrarySearch } from '../../../shared/search/query';
import type { Snapshot, SyncPacket } from '../../../shared/streaming/protocol';
import { conversationMenu, openParameters } from '../../support/browser/ui';

const origin = 'http://127.0.0.1:5174',
  headers = { Origin: origin },
  fact = '__SUMMARY_FACT_42__';
async function replay(request: APIRequestContext, id: string) {
  const { cookies } = await request.storageState();
  const socket = new WebSocket(
    `${origin.replace('http:', 'ws:')}/api/conversations/${id}/sync?after=0`,
    {
      headers: {
        ...headers,
        Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
      },
    },
  );
  const packets: SyncPacket[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Replay timeout')), 10_000);
      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      socket.on('message', (data) => {
        const packet = JSON.parse(data.toString()) as SyncPacket;
        packets.push(packet);
        if (packet.type === 'ready') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    return packets;
  } finally {
    socket.terminate();
  }
}
async function setup(
  request: APIRequestContext,
  branch = false,
  longTail = false,
  longHistory = false,
) {
  expect((await request.post('/__dev/access/login', { headers })).ok()).toBe(true);
  const original = (await request
    .get('/api/settings/providers')
    .then((response) => response.json())) as ProviderSettings;
  const providerId = crypto.randomUUID(),
    empty = crypto.randomUUID(),
    ids: string[] = [empty];
  const configuration: ProviderSettingsInput = {
    providers: [
      {
        id: providerId,
        name: 'Summary fixture',
        provider: 'openai-chat',
        baseUrl: 'https://provider.test/v1',
        apiKey: 'integration-test-key',
        models: [
          'alarm-stall',
          'benchmark-answer-fact',
          'tools-openai-chat',
          'benchmark-summary-ok',
          'benchmark-summary-slow',
          'benchmark-summary-empty',
          'benchmark-summary-length',
          'benchmark-summary-error',
          'benchmark-summary-write-failure',
          'benchmark-summary-small',
        ].map((id) => ({
          id,
          name: id,
          enabled: true,
          metadataOverrides: {
            contextWindow: id === 'alarm-stall' ? 4096 : id.endsWith('small') ? 1024 : 65536,
            maxOutputTokens: 4096,
            toolCalls: id === 'tools-openai-chat',
          },
        })),
      },
    ],
    activeProviderId: providerId,
    activeModel: 'alarm-stall',
    systemPrompt: 'CHAT SYSTEM',
    maxOutputTokens: null,
  };
  const configure = (input = configuration) =>
    request.put('/api/settings/providers', { headers, data: input });
  expect((await configure()).status()).toBe(200);
  expect(
    (
      await request.post('/api/conversations', {
        headers,
        data: { id: empty, title: '历史摘要测试' },
      })
    ).status(),
  ).toBe(201);
  const backup = (await request
    .get(`/api/conversations/${empty}/backup`)
    .then((response) => response.json())) as EverChatBackup;
  let parentId: string | null = null;
  backup.conversation.settings = { ...defaults, contextBudget: 400 };
  backup.conversation.messages = [
    `预算 42 元，标识 ${fact}。${'旧资料 '.repeat(longHistory ? 3000 : 500)}`,
    '已确认预算和约束。',
    '最近问题',
    '最近回答',
    longTail ? '后续问题'.repeat(500) : '后续问题',
    '后续回答',
  ].map((text, index) => {
    const id = crypto.randomUUID(),
      message = {
        id,
        role: index % 2 ? ('assistant' as const) : ('user' as const),
        parts: messageParts(text),
        status: 'completed' as const,
        createdAt: index + 1,
        parentId,
        revisionOf: null,
        error: null,
        providerId: null,
        model: null,
        modelName: null,
      };
    parentId = id;
    return message;
  });
  if (branch) {
    const id = crypto.randomUUID();
    backup.conversation.messages.push(
      {
        ...backup.conversation.messages[0],
        id,
        parts: messageParts('另一个话题'),
        createdAt: 7,
        revisionOf: backup.conversation.messages[0].id,
      },
      {
        ...backup.conversation.messages[1],
        id: crypto.randomUUID(),
        parentId: id,
        parts: messageParts('另一分支回答'),
        createdAt: 8,
      },
    );
  }
  const restored = await request.post('/api/backup/restore', { headers, data: backup });
  expect(restored.status()).toBe(201);
  const { id, snapshot: seeded } = (await restored.json()) as { id: string; snapshot: Snapshot };
  ids.push(id);
  expect((await configure()).status()).toBe(200);
  const snapshot = () =>
    request
      .get(`/api/conversations/${id}`)
      .then((response) => response.json()) as Promise<Snapshot>;
  const submit = (input: Partial<SubmitInput>) =>
    request.post(`/api/conversations/${id}/messages`, {
      headers,
      data: {
        requestId: crypto.randomUUID(),
        ...(!input.summaryThrough && !input.retryOf && !input.revisionOf
          ? { parentId: seeded.messages.at(-1)!.id }
          : {}),
        ...input,
      },
    });
  const summarize = (model = 'benchmark-summary-ok', patch: Partial<SubmitInput> = {}) =>
    submit({ summaryThrough: seeded.messages[1].id, selection: { providerId, model }, ...patch });
  const run = (runId: string) =>
    request
      .post(`/api/__test/conversations/${id}/context`, { headers, data: { runId } })
      .then((response) => response.json()) as Promise<{
      context: ChatInput[];
      config: Record<string, unknown>;
    }>;
  const stop = (runId: string) =>
    request.post(`/api/conversations/${id}/cancel`, { headers, data: { runId } });
  const resources = () =>
    request
      .post(`/api/__test/conversations/${id}/resources`, { headers, data: {} })
      .then((response) => response.json());
  const terminal = async (task: Submission, status = 'completed') => {
    await expect
      .poll(
        async () =>
          (await snapshot()).messages.find((message) => message.id === task.assistantId)?.status,
      )
      .toBe(status);
    return (await snapshot()).messages.find((message) => message.id === task.assistantId)!;
  };
  const startSummary = async (model = 'benchmark-summary-ok', patch: Partial<SubmitInput> = {}) => {
    const response = await summarize(model, patch);
    expect(response.status()).toBe(202);
    return response.json() as Promise<Submission>;
  };
  return {
    id,
    providerId,
    ids,
    seeded,
    configuration,
    configure,
    snapshot,
    submit,
    summarize,
    startSummary,
    run,
    stop,
    resources,
    terminal,
    cleanup: async () => {
      for (const id of ids) await request.delete(`/api/conversations/${id}`, { headers });
      expect(
        (await request.put('/api/settings/providers', { headers, data: original })).status(),
      ).toBe(200);
    },
  };
}

function automaticInput(
  fixture: Awaited<ReturnType<typeof setup>>,
  summaryModel = 'benchmark-summary-ok',
  budget = 400,
): SubmitInput {
  return {
    parentId: fixture.seeded.messages.at(-1)!.id,
    requestId: crypto.randomUUID(),
    content: '还记得早先的预算吗？',
    selection: { providerId: fixture.providerId, model: 'benchmark-answer-fact' },
    settings: {
      ...defaults,
      contextBudget: budget,
      autoCompression: {
        enabled: true,
        threshold: 80,
        model: { providerId: fixture.providerId, model: summaryModel },
      },
    },
  };
}
const action = (request: APIRequestContext, id: string, name: string, runId: string) =>
  request.post(`/api/__test/conversations/${id}/${name}`, { headers, data: { runId } });

for (const outcome of ['completed', 'failed', 'cancelled'] as const)
  test(`tool-enabled automatic summary ${outcome} settles the dependent process and produces a valid backup`, async ({
    request,
  }) => {
    const fixture = await setup(request, false, false, true);
    try {
      const model =
        outcome === 'failed'
          ? 'benchmark-summary-error'
          : outcome === 'cancelled'
            ? 'benchmark-summary-slow'
            : 'benchmark-summary-ok';
      const input = automaticInput(fixture, model, 5000);
      input.selection!.model = 'tools-openai-chat';
      input.tools = ['web_search', 'read_webpage'];
      const response = await fixture.submit(input);
      expect(response.status(), await response.text()).toBe(202);
      const task = (await response.json()) as Submission;
      expect(task.summaryId).toBeTruthy();
      if (outcome === 'cancelled') {
        await expect
          .poll(
            async () =>
              (await fixture.snapshot()).messages.find((message) => message.id === task.summaryId)
                ?.status,
          )
          .toBe('running');
        expect((await fixture.stop(task.runId)).ok()).toBe(true);
      }
      const answer = await fixture.terminal(task, outcome);
      expect(answer.tools?.status).toBe(outcome);
      expect(answer.tools?.calls).toHaveLength(outcome === 'completed' ? 2 : 0);
      expect((await fixture.resources()).calls).toBe(outcome === 'completed' ? 3 : 1);
      const backup = (await request
        .get(`/api/conversations/${fixture.id}/backup`)
        .then((result) => result.json())) as EverChatBackup;
      expect(() => validateBackup(backup)).not.toThrow();
      expect(
        backup.conversation.messages.find((message) => message.id === task.assistantId)?.tools
          ?.status,
      ).toBe(outcome);
    } finally {
      await fixture.cleanup();
    }
  });

test('automatic compression saves coverage before answering, retains early facts and is idempotent across refresh and a second device', async ({
  request,
  browser,
}) => {
  const fixture = await setup(request),
    other = await browser.newContext();
  try {
    const input = automaticInput(fixture);
    const responses = await Promise.all([fixture.submit(input), fixture.submit(input)]);
    for (const response of responses) expect(response.status()).toBe(202);
    const task = (await responses[0].json()) as Submission;
    expect(await responses[1].json()).toEqual(task);
    const queued = await fixture.snapshot(),
      summary = queued.messages.find(({ id }) => id === task.summaryId)!;
    expect(summary.summary).toEqual({
      throughId: fixture.seeded.messages[3].id,
      sourceIds: fixture.seeded.messages.slice(0, 4).map(({ id }) => id),
      automatic: true,
    });
    expect(queued.messages.at(-1)).toMatchObject({
      waitingForSummary: summary.id,
      status: 'queued',
    });
    expect((await fixture.run(task.runId)).context).toEqual([]);
    expect(
      (await action(request, fixture.id, 'state', task.runId).then((response) => response.json()))
        .calls,
    ).toBe(0);
    await other.request.post('/__dev/access/login', { headers });
    const page = await other.newPage();
    await page.goto(`/c/${fixture.id}`);
    await page.reload();
    await page.close();
    const answer = await fixture.terminal(task);
    expect(messageText(answer)).toBe('记得预算 42 元。');
    expect(answer.waitingForSummary).toBeUndefined();
    expect(answer.generation!.context).toMatchObject({
      summaryId: summary.id,
      summarizedMessages: 4,
      omittedMessages: 0,
      retainedMessages: 2,
    });
    const saved = await fixture.snapshot();
    expect(saved.messages.slice(0, 6)).toEqual(fixture.seeded.messages);
    expect(saved.messages.find(({ id }) => id === summary.id)?.status).toBe('completed');
    expect(await fixture.resources()).toMatchObject({
      calls: 2,
      dependencies: 0,
      retainedContexts: 0,
    });
    await action(request, fixture.id, 'alarm', task.runId);
    const disabled = {
      ...fixture.configuration,
      providers: fixture.configuration.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, enabled: false })),
      })),
    };
    await fixture.configure(disabled);
    const duplicate = await fixture.submit(input);
    expect(duplicate.status()).toBe(202);
    expect(await duplicate.json()).toEqual(task);
    expect(
      (await replay(other.request, fixture.id)).some((packet) =>
        (packet.type === 'snapshot'
          ? packet.snapshot.messages
          : packet.type === 'change'
            ? packet.messages
            : []
        ).some((message) => message.id === summary.id && message.status === 'completed'),
      ),
    ).toBe(true);
    expect(await fixture.resources()).toMatchObject({ calls: 2 });
  } finally {
    await other.close();
    await fixture.cleanup();
  }
});

test('automatic compression pins both models and chat settings before the summary finishes', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const input = automaticInput(fixture, 'benchmark-summary-slow');
    input.selection!.model = 'alarm-stall';
    const response = await fixture.submit(input);
    expect(response.status()).toBe(202);
    const task = (await response.json()) as Submission;
    const summary = (await fixture.snapshot()).messages.find(({ id }) => id === task.summaryId)!;
    expect((await fixture.run(summary.runId!)).config).toMatchObject({
      model: 'benchmark-summary-slow',
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
    });
    const changed: ConversationSettings = {
      ...defaults,
      contextBudget: 100,
      recentMessages: 1,
      systemPrompt: 'CHANGED',
      autoCompression: defaults.autoCompression,
    };
    expect(
      (
        await request.put(`/api/conversations/${fixture.id}/settings`, { headers, data: changed })
      ).status(),
    ).toBe(200);
    await fixture.configure({
      ...fixture.configuration,
      systemPrompt: 'ALSO CHANGED',
      providers: fixture.configuration.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, enabled: false })),
      })),
    });
    await expect
      .poll(async () => (await fixture.snapshot()).messages.at(-1)!.status)
      .toBe('running');
    const answerRun = await fixture.run(task.runId);
    expect(answerRun.config).toMatchObject({
      model: 'alarm-stall',
      systemPrompt: 'CHAT SYSTEM',
      maxOutputTokens: null,
    });
    expect(answerRun.context).toHaveLength(4);
    expect(answerRun.context[0].content).toContain(fact);
    expect(answerRun.context[1].content).toBe('后续问题');
    expect(answerRun.context.at(-1)!.content).toBe(input.content);
    expect((await fixture.snapshot()).messages.at(-1)!.generation!.context!.inputBudget).toBe(400);
    expect(await fixture.resources()).toMatchObject({ calls: 2, dependencies: 0 });
    await fixture.stop(task.runId);
  } finally {
    await fixture.cleanup();
  }
});

test('distinct concurrent automatic requests accept only one paid pipeline, and copying a waiting pipeline cannot restart it', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const responses = await Promise.all([
      fixture.submit(automaticInput(fixture, 'benchmark-summary-slow')),
      fixture.submit(automaticInput(fixture, 'benchmark-summary-slow')),
    ]);
    expect(responses.map((response) => response.status()).sort()).toEqual([202, 409]);
    const task = (await responses
      .find((response) => response.status() === 202)!
      .json()) as Submission;
    const copied = await request.post(`/api/conversations/${fixture.id}/duplicate`, {
      headers,
      data: { requestId: crypto.randomUUID() },
    });
    expect(copied.status()).toBe(201);
    const { id, snapshot } = (await copied.json()) as { id: string; snapshot: Snapshot };
    fixture.ids.push(id);
    const summary = snapshot.messages.find((message) => message.summary)!;
    expect(summary).toMatchObject({ status: 'failed', summary: { automatic: true } });
    expect(snapshot.messages.at(-1)).toMatchObject({ status: 'failed' });
    expect(snapshot.messages.at(-1)!.waitingForSummary).toBeUndefined();
    expect(summary.summary!.sourceIds).toEqual(snapshot.messages.slice(0, 4).map(({ id }) => id));
    expect(
      snapshot.messages.some(
        (message) => message.status === 'queued' || message.status === 'running',
      ),
    ).toBe(false);
    await action(request, id, 'alarm', task.runId);
    expect(
      await action(request, id, 'resources', task.runId).then((response) => response.json()),
    ).toMatchObject({ calls: 0, runs: 0, dependencies: 0 });
    await fixture.stop(task.runId);
    expect(await fixture.resources()).toMatchObject({ dependencies: 0 });
    const backup = (await request
      .get(`/api/conversations/${id}/backup`)
      .then((response) => response.json())) as EverChatBackup;
    expect(
      backup.conversation.messages.find((message) => message.summary)?.summary?.automatic,
    ).toBe(true);
    expect(JSON.stringify(backup)).not.toContain('waitingForSummary');
  } finally {
    await fixture.cleanup();
  }
});

for (const model of [
  'benchmark-summary-empty',
  'benchmark-summary-length',
  'benchmark-summary-error',
  'benchmark-summary-write-failure',
])
  test(`automatic ${model} failure retains originals, skips the answer and never retries on Alarm`, async ({
    request,
  }) => {
    const fixture = await setup(request);
    try {
      const input = automaticInput(fixture, model),
        response = await fixture.submit(input);
      expect(response.status()).toBe(202);
      const task = (await response.json()) as Submission,
        answer = await fixture.terminal(task, 'failed');
      expect(answer.error).toContain('回答未调用模型');
      expect(answer.generation!.timing).toBeUndefined();
      expect(answer.waitingForSummary).toBeUndefined();
      const saved = await fixture.snapshot();
      expect(saved.messages.slice(0, 6)).toEqual(fixture.seeded.messages);
      expect(saved.messages.find(({ id }) => id === task.summaryId)?.status).toBe('failed');
      expect(await fixture.resources()).toMatchObject({
        calls: 1,
        dependencies: 0,
        retainedContexts: 0,
      });
      await action(request, fixture.id, 'alarm', task.runId);
      expect(await (await fixture.submit(input)).json()).toEqual(task);
      expect(await fixture.resources()).toMatchObject({ calls: 1 });
    } finally {
      await fixture.cleanup();
    }
  });

for (const running of [false, true])
  test(`automatic compression can stop ${running ? 'a live summary' : 'a waiting answer'} without starting the answer`, async ({
    request,
  }) => {
    const fixture = await setup(request);
    try {
      const response = await fixture.submit(automaticInput(fixture, 'benchmark-summary-slow'));
      expect(response.status()).toBe(202);
      const task = (await response.json()) as Submission,
        summary = (await fixture.snapshot()).messages.find(({ id }) => id === task.summaryId)!;
      if (running)
        await expect
          .poll(
            async () =>
              messageText((await fixture.snapshot()).messages.find(({ id }) => id === summary.id)!)
                .length,
          )
          .toBeGreaterThan(0);
      expect((await fixture.stop(running ? summary.runId! : task.runId)).ok()).toBe(true);
      await fixture.terminal(task, 'cancelled');
      const saved = await fixture.snapshot();
      expect(saved.messages.find(({ id }) => id === summary.id)?.status).toBe('cancelled');
      expect(saved.messages.slice(0, 6)).toEqual(fixture.seeded.messages);
      await action(request, fixture.id, 'alarm', task.runId);
      expect(await fixture.resources()).toMatchObject({
        calls: running ? 1 : 0,
        dependencies: 0,
        retainedContexts: 0,
      });
    } finally {
      await fixture.cleanup();
    }
  });

test('resetting a live automatic summary preserves its checkpoint and fails its waiting answer without a paid retry', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const input = automaticInput(fixture, 'benchmark-summary-slow'),
      response = await fixture.submit(input);
    expect(response.status()).toBe(202);
    const task = (await response.json()) as Submission,
      summary = (await fixture.snapshot()).messages.find(({ id }) => id === task.summaryId)!;
    await expect
      .poll(
        async () =>
          messageText((await fixture.snapshot()).messages.find(({ id }) => id === summary.id)!)
            .length,
      )
      .toBeGreaterThan(0);
    const prefix = messageText(
      (await fixture.snapshot()).messages.find(({ id }) => id === summary.id)!,
    );
    try {
      await action(request, fixture.id, 'abort', summary.runId!);
    } catch {
      /* A deliberate reset can close this request. */
    }
    await fixture.terminal(task, 'failed');
    const saved = await fixture.snapshot();
    expect(messageText(saved.messages.find(({ id }) => id === summary.id)!)).toContain(prefix);
    expect(saved.messages.slice(0, 6)).toEqual(fixture.seeded.messages);
    expect(await fixture.resources()).toMatchObject({ calls: 1, dependencies: 0 });
    await action(request, fixture.id, 'alarm', task.runId);
    expect(await (await fixture.submit(input)).json()).toEqual(task);
    expect(await fixture.resources()).toMatchObject({ calls: 1 });
  } finally {
    await fixture.cleanup();
  }
});

test('a reset after the automatic summary is saved resumes only the accepted answer', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const response = await fixture.submit(automaticInput(fixture));
    expect(response.status()).toBe(202);
    const task = (await response.json()) as Submission;
    await expect
      .poll(
        async () =>
          (await fixture.snapshot()).messages.find(({ id }) => id === task.summaryId)?.status,
        { intervals: [50] },
      )
      .toBe('completed');
    expect((await fixture.snapshot()).messages.at(-1)!.status).toBe('queued');
    try {
      await action(request, fixture.id, 'abort', task.runId);
    } catch {
      /* A deliberate reset can close this request. */
    }
    expect(messageText(await fixture.terminal(task))).toBe('记得预算 42 元。');
    expect(await fixture.resources()).toMatchObject({
      calls: 2,
      dependencies: 0,
      retainedContexts: 0,
    });
  } finally {
    await fixture.cleanup();
  }
});

test('automatic compression rejects unavailable or undersized summary models before writes, and stops when the resulting summary still cannot fit', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const before = await fixture.snapshot();
    for (const model of ['not-enabled', 'benchmark-summary-small']) {
      const response = await fixture.submit(automaticInput(fixture, model));
      expect(response.status()).toBe(400);
      expect(await fixture.snapshot()).toEqual(before);
      expect(await fixture.resources()).toMatchObject({ calls: 0, runs: 0 });
    }
    const fixed = automaticInput(fixture);
    fixed.content = '超长输入'.repeat(300);
    expect((await fixture.submit(fixed)).status()).toBe(400);
    expect(await fixture.resources()).toMatchObject({ calls: 0, runs: 0 });
    const response = await fixture.submit(automaticInput(fixture, 'benchmark-summary-ok', 100));
    expect(response.status()).toBe(202);
    const task = (await response.json()) as Submission,
      answer = await fixture.terminal(task, 'failed');
    expect(answer.error).toContain('超过上下文预算');
    expect(
      (await fixture.snapshot()).messages.find(({ id }) => id === task.summaryId)?.status,
    ).toBe('completed');
    expect((await fixture.snapshot()).messages.slice(0, 6)).toEqual(fixture.seeded.messages);
    await action(request, fixture.id, 'alarm', task.runId);
    expect(await fixture.resources()).toMatchObject({
      calls: 1,
      dependencies: 0,
      retainedContexts: 0,
    });
  } finally {
    await fixture.cleanup();
  }
});

test('automatic compression preferences autosave with fee disclosure, offline edits, cross-device sync and an actionable chat preview', async ({
  page,
  request,
  context,
  browser,
}) => {
  const fixture = await setup(page.request),
    other = await browser.newContext();
  try {
    await page.goto(`/c/${fixture.id}`);
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('待发送草稿');
    await openParameters(page);
    const modal = page.getByRole('dialog', { name: '会话参数', exact: true });
    await expect(modal.getByLabel('自动压缩历史', { exact: true })).not.toBeChecked();
    await expect(modal).toContainText('额外调用摘要模型');
    await modal.getByLabel('自动压缩历史', { exact: true }).check();
    await modal
      .getByLabel('自动摘要模型', { exact: true })
      .selectOption(
        modelSelectionKey({ providerId: fixture.providerId, model: 'benchmark-summary-slow' }),
      );
    await expect(modal.getByRole('status')).toHaveText('已保存');
    await other.request.post('/__dev/access/login', { headers });
    const second = await other.newPage();
    await second.goto(`/c/${fixture.id}`);
    await openParameters(second);
    await expect(second.getByLabel('自动压缩历史', { exact: true })).toBeChecked();
    await context.setOffline(true);
    await modal.getByLabel('自动压缩阈值（%）', { exact: true }).fill('70');
    await expect(modal.getByRole('alert')).toBeVisible();
    await modal.getByRole('button', { name: '关闭会话参数' }).click();
    await expect(composer).toHaveValue('待发送草稿');
    await expect(page.getByTestId('automatic-compression-preview')).toContainText(
      '额外调用摘要模型',
    );
    await context.setOffline(false);
    await expect
      .poll(async () => (await fixture.snapshot()).settings?.autoCompression.threshold)
      .toBe(70);
    await expect(second.getByLabel('自动压缩阈值（%）', { exact: true })).toHaveValue('70');
    await page.reload();
    await expect(composer).toHaveValue('待发送草稿');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('等待历史摘要', { exact: true })).toBeVisible();
    await expect(page.getByTestId('summary-message')).toContainText('自动历史摘要');
    await page.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect
      .poll(async () => (await fixture.snapshot()).messages.at(-1)!.status)
      .toBe('cancelled');
    await openParameters(page);
    await modal.getByLabel('使用历史摘要', { exact: true }).uncheck();
    await expect(modal.getByLabel('自动压缩历史', { exact: true })).not.toBeChecked();
    await expect(modal.getByRole('status')).toHaveText('已保存');
    expect((await fixture.snapshot()).settings?.autoCompression.enabled).toBe(false);
  } finally {
    await context.setOffline(false);
    await other.close();
    await fixture.cleanup();
  }
});

test('automatic compression does not silently discard an oversized uncompressed recent turn', async ({
  request,
}) => {
  const fixture = await setup(request, false, true);
  try {
    const response = await fixture.submit(automaticInput(fixture));
    expect(response.status()).toBe(202);
    const task = (await response.json()) as Submission,
      answer = await fixture.terminal(task, 'failed');
    expect(answer.error).toContain('自动摘要后仍无法容纳最近历史');
    expect((await fixture.snapshot()).messages.slice(0, 6)).toEqual(fixture.seeded.messages);
    expect(await fixture.resources()).toMatchObject({ calls: 1, dependencies: 0 });
  } finally {
    await fixture.cleanup();
  }
});

test('manual summaries pin complete input, are idempotent after model changes, and preserve old facts in bounded chat context', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const input = { requestId: crypto.randomUUID() };
    const responses = await Promise.all([
      fixture.summarize('benchmark-summary-ok', input),
      fixture.summarize('benchmark-summary-ok', input),
    ]);
    for (const response of responses) expect(response.status()).toBe(202);
    const task = (await responses[0].json()) as Submission;
    expect(await responses[1].json()).toEqual(task);
    const pinned = await fixture.run(task.runId);
    expect(pinned.config).toMatchObject({
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      model: 'benchmark-summary-ok',
      maxOutputTokens: 2048,
    });
    expect(pinned.config.apiKey).toBeUndefined();
    expect(pinned.context).toHaveLength(3);
    expect(pinned.context[0].content).toBe(messageText(fixture.seeded.messages[0]));
    const queued = (await fixture.snapshot()).messages.find(({ id }) => id === task.assistantId)!;
    expect(queued.summary).toEqual({
      throughId: fixture.seeded.messages[1].id,
      sourceIds: fixture.seeded.messages.slice(0, 2).map(({ id }) => id),
    });
    expect(queued.generation!.context).toMatchObject({ omittedMessages: 0, retainedMessages: 2 });
    expect(
      (
        await fixture.configure({
          ...fixture.configuration,
          systemPrompt: 'CHANGED',
          activeProviderId: null,
          activeModel: '',
          providers: fixture.configuration.providers.map((provider) => ({
            ...provider,
            models: provider.models.map((model) => ({ ...model, enabled: false })),
          })),
        })
      ).status(),
    ).toBe(200);
    const summary = await fixture.terminal(task);
    expect(messageText(summary)).toContain(fact);
    expect(summary.generation!.usage).toMatchObject({ inputTokens: 55, outputTokens: 19 });
    const duplicate = await fixture.summarize('benchmark-summary-ok', input);
    expect(duplicate.status()).toBe(202);
    expect(await duplicate.json()).toEqual(task);
    expect((await fixture.resources()).calls).toBe(1);
    expect((await fixture.snapshot()).messages.slice(0, 6)).toEqual(fixture.seeded.messages);
    expect((await fixture.configure()).status()).toBe(200);
    const response = await fixture.submit({
      content: '预算是多少？',
      parentId: fixture.seeded.messages[5].id,
    });
    expect(response.status()).toBe(202);
    const answer = (await response.json()) as Submission,
      context = await fixture.run(answer.runId);
    expect(context.config.maxOutputTokens).toBeNull();
    expect(context.config.systemPrompt).toBe('CHAT SYSTEM');
    expect(context.context[0]).toMatchObject({ role: 'user' });
    expect(context.context[0].content).toContain(fact);
    expect(context.context.map(({ content }) => content)).not.toContain(
      messageText(fixture.seeded.messages[0]),
    );
    expect(context.context.slice(1, -1).map(({ content }) => content)).toEqual(
      fixture.seeded.messages.slice(2, 6).map((message) => messageText(message)),
    );
    expect((await fixture.snapshot()).messages.at(-1)!.generation!.context).toMatchObject({
      summaryId: summary.id,
      summarizedMessages: 2,
      omittedMessages: 0,
    });
    await fixture.stop(answer.runId);
  } finally {
    await fixture.cleanup();
  }
});

test('invalid and too-large summaries do not write or call a supplier; cancellation and failed output keep original history', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    for (const patch of [
      { content: '' },
      { retryOf: fixture.seeded.messages[1].id },
      { settings: defaults },
      { reasoningEffort: 'high' as const },
      { parentId: fixture.seeded.messages[1].id },
    ])
      expect((await fixture.summarize('benchmark-summary-ok', patch)).status()).toBe(400);
    expect((await fixture.summarize('benchmark-summary-small')).status()).toBe(400);
    expect(
      (
        await fixture.summarize('benchmark-summary-ok', {
          summaryThrough: fixture.seeded.messages[0].id,
        })
      ).status(),
    ).toBe(400);
    expect((await fixture.snapshot()).messages).toEqual(fixture.seeded.messages);
    expect((await fixture.resources()).calls).toBe(0);
    const cancelled = await fixture.startSummary();
    await fixture.stop(cancelled.runId);
    expect((await fixture.terminal(cancelled, 'cancelled')).parts).toEqual([]);
    expect((await fixture.resources()).calls).toBe(0);
    for (const model of [
      'benchmark-summary-empty',
      'benchmark-summary-length',
      'benchmark-summary-error',
    ]) {
      const failed = await fixture.startSummary(model);
      const message = await fixture.terminal(failed, 'failed');
      expect(message.error).toBeTruthy();
    }
    expect((await fixture.resources()).calls).toBe(3);
    const chat = await fixture.submit({ content: 'next', parentId: fixture.seeded.messages[5].id });
    expect(chat.status()).toBe(202);
    const task = (await chat.json()) as Submission;
    const context = await fixture.run(task.runId);
    expect(JSON.stringify(context.context)).not.toContain('conversation_summary');
    expect((await fixture.snapshot()).messages.at(-1)!.generation!.context).toMatchObject({
      omittedMessages: 2,
    });
    expect((await fixture.snapshot()).messages.slice(0, 6)).toEqual(fixture.seeded.messages);
    await fixture.stop(task.runId);
  } finally {
    await fixture.cleanup();
  }
});

test('summary boundaries are branch-specific, incremental compression reuses only earlier coverage, and disabling uses raw history', async ({
  request,
}) => {
  const fixture = await setup(request, true);
  try {
    const first = await fixture.startSummary(),
      early = await fixture.terminal(first);
    const widerTask = await fixture.startSummary('benchmark-summary-ok', {
      summaryThrough: fixture.seeded.messages[3].id,
    });
    const widerInput = await fixture.run(widerTask.runId);
    expect(widerInput.context[0].content).toContain(fact);
    expect(widerInput.context[1].content).toBe(messageText(fixture.seeded.messages[2]));
    const wider = await fixture.terminal(widerTask);
    expect(wider.summary!.sourceIds).toEqual(
      fixture.seeded.messages.slice(0, 4).map(({ id }) => id),
    );
    expect(wider.generation!.context!.summaryId).toBe(early.id);
    for (const [head, enabled, expected] of [
      [fixture.seeded.messages[5].id, true, wider.id],
      [fixture.seeded.messages[7].id, true, undefined],
      [fixture.seeded.messages[5].id, false, undefined],
    ] as const) {
      const response = await fixture.submit({
        content: 'next',
        parentId: head,
        settings: { ...defaults, contextBudget: 400, useSummaries: enabled },
      });
      expect(response.status()).toBe(202);
      const task = (await response.json()) as Submission,
        context = await fixture.run(task.runId);
      expect((await fixture.snapshot()).messages.at(-1)!.generation!.context!.summaryId).toBe(
        expected,
      );
      if (expected) expect(context.context[0].content).toContain(fact);
      else expect(context.context.some(({ content }) => content.includes(fact))).toBe(false);
      await fixture.stop(task.runId);
    }
    const repeatTask = await fixture.startSummary('benchmark-summary-ok', {
      summaryThrough: fixture.seeded.messages[3].id,
    });
    const input = await fixture.run(repeatTask.runId);
    expect(input.context[0].content).toContain(messageText(early));
    expect(
      (await fixture.snapshot()).messages.find(({ id }) => id === repeatTask.assistantId)!
        .generation!.context!.summaryId,
    ).toBe(early.id);
    await fixture.stop(repeatTask.runId);
  } finally {
    await fixture.cleanup();
  }
});

test('copies and backups remap coverage and generation references; deleting a source clears derived summaries and replay', async ({
  request,
}) => {
  const fixture = await setup(request, true);
  try {
    const task = await fixture.startSummary(),
      summary = await fixture.terminal(task);
    const indexed = async () =>
      (
        (await request
          .get('/api/search?q=SUMMARY_FACT_42')
          .then((response) => response.json())) as LibrarySearch
      ).results
        .filter((result) => result.conversationId === fixture.id)
        .map(({ messageId }) => messageId);
    await expect.poll(indexed).toEqual([fixture.seeded.messages[0].id]);
    await request.post('/api/__test/library/search', {
      headers,
      data: { id: fixture.id, rebuild: true },
    });
    await expect
      .poll(
        async () =>
          (
            await request
              .post('/api/__test/library/search', { headers, data: { id: fixture.id } })
              .then((response) => response.json())
          ).progress?.done,
      )
      .toBe(1);
    expect(await indexed()).toEqual([fixture.seeded.messages[0].id]);
    const answerResponse = await fixture.submit({
      content: 'next',
      parentId: fixture.seeded.messages[5].id,
    });
    expect(answerResponse.status()).toBe(202);
    const answer = (await answerResponse.json()) as Submission;
    await fixture.stop(answer.runId);
    const checkCopy = (snapshot: Snapshot) => {
      const copiedSummary = snapshot.messages.find((message) => message.summary)!;
      expect(copiedSummary.id).not.toBe(summary.id);
      expect(messageText(copiedSummary)).toBe(messageText(summary));
      const originals = snapshot.messages.filter((message) => !message.summary);
      expect(copiedSummary.summary).toEqual({
        throughId: originals[1].id,
        sourceIds: originals.slice(0, 2).map(({ id }) => id),
      });
      expect(copiedSummary.generation!.usage).toEqual(summary.generation!.usage);
      expect(
        originals.find((message) => message.role === 'assistant' && message.status === 'cancelled')!
          .generation!.context!.summaryId,
      ).toBe(copiedSummary.id);
      expect(snapshot.settings!.useSummaries).toBe(true);
    };
    const copied = await request.post(
      `/api/conversations/${fixture.id}/messages/${answer.assistantId}/duplicate`,
      { headers, data: { requestId: crypto.randomUUID() } },
    );
    expect(copied.status()).toBe(201);
    const copy = (await copied.json()) as { id: string; snapshot: Snapshot };
    fixture.ids.push(copy.id);
    checkCopy(copy.snapshot);
    expect(copy.snapshot.messages.some((message) => messageText(message) === '另一个话题')).toBe(
      false,
    );
    const backup = (await request
      .get(`/api/conversations/${fixture.id}/backup`)
      .then((response) => response.json())) as EverChatBackup;
    const restored = await request.post('/api/backup/restore', { headers, data: backup });
    expect(restored.status()).toBe(201);
    const restore = (await restored.json()) as { id: string; snapshot: Snapshot };
    fixture.ids.push(restore.id);
    checkCopy(restore.snapshot);
    expect((await fixture.configure()).status()).toBe(200);
    const before = await fixture.snapshot();
    expect(
      (
        await request.delete(
          `/api/conversations/${fixture.id}/messages/${fixture.seeded.messages[0].id}`,
          { headers },
        )
      ).status(),
    ).toBe(200);
    const after = await fixture.snapshot(),
      cleared = after.messages.find(({ id }) => id === summary.id)!;
    expect(cleared.deletedAt).toBeTruthy();
    expect(cleared.parts).toEqual([]);
    expect(cleared.generation).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain(fact);
    await expect.poll(indexed).toEqual([]);
    const redacted = await request
      .get(`/api/conversations/${fixture.id}/backup`)
      .then((response) => response.text());
    expect(redacted).not.toContain(fact);
    const packets = await replay(request, fixture.id);
    expect(packets[0].type).toBe('snapshot');
    expect(JSON.stringify(packets)).not.toContain(fact);
    const fresh = await fixture.submit({
      content: 'next',
      parentId: fixture.seeded.messages[5].id,
    });
    expect(fresh.status()).toBe(202);
    const next = (await fresh.json()) as Submission;
    expect(JSON.stringify((await fixture.run(next.runId)).context)).not.toContain(fact);
    await fixture.stop(next.runId);
    expect(before.messages.find(({ id }) => id === summary.id)!.parts.length).toBeGreaterThan(0);
  } finally {
    await fixture.cleanup();
  }
});

test('summary controls stream Markdown, preserve the draft and URL, sync another device, and never replay a paid request on refresh', async ({
  page,
  browser,
}) => {
  const fixture = await setup(page.request),
    other = await browser.newContext({ storageState: await page.context().storageState() });
  try {
    await page.goto(`/c/${fixture.id}`);
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('保留的聊天草稿');
    await conversationMenu(page);
    await page.getByRole('menuitem', { name: '压缩历史', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '压缩历史', exact: true });
    await expect(modal.getByLabel('摘要模型', { exact: true })).toBeFocused();
    await expect(modal).toContainText('会额外调用所选模型，可能产生费用');
    await modal
      .getByLabel('摘要模型', { exact: true })
      .selectOption(
        modelSelectionKey({ providerId: fixture.providerId, model: 'benchmark-summary-slow' }),
      );
    await modal
      .getByLabel('摘要覆盖边界', { exact: true })
      .selectOption(fixture.seeded.messages[1].id);
    await modal.getByRole('button', { name: '生成摘要', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(composer).toHaveValue('保留的聊天草稿');
    await expect(composer).toBeFocused();
    await expect(page).toHaveURL((url) => url.pathname === `/c/${fixture.id}`);
    const card = page.getByTestId('summary-message');
    await expect(card).toHaveAttribute('data-status', 'running');
    await expect(card.locator('h1')).toHaveText('历史摘要');
    await expect(card).not.toContainText('继续处理后续问题。');
    const second = await other.newPage();
    await second.goto(`/c/${fixture.id}`);
    await page.close();
    await expect(second.getByTestId('summary-message')).toHaveAttribute('data-status', 'completed');
    const persisted = second.getByTestId('summary-message');
    const group = second.getByTestId('branch-summaries').locator('details').first();
    if (!(await group.evaluate((element: HTMLDetailsElement) => element.open)))
      await group.locator('summary').first().click();
    if (
      !(await persisted
        .locator('details')
        .first()
        .evaluate((element: HTMLDetailsElement) => element.open))
    )
      await persisted.locator('summary').first().click();
    await expect(
      persisted.locator('[data-streamdown="strong"]').filter({ hasText: /^42 元$/ }),
    ).toHaveText('42 元');
    await second.getByRole('button', { name: '查看上下文估算' }).click();
    await expect(second.getByRole('dialog', { name: '上下文估算', exact: true })).toContainText(
      '覆盖 2 条',
    );
    await second.keyboard.press('Escape');
    expect((await fixture.resources()).calls).toBe(1);
    await second.reload();
    await expect(second.getByTestId('summary-message')).toHaveAttribute('data-status', 'completed');
    expect((await fixture.resources()).calls).toBe(1);
    await openParameters(second);
    const settings = second.getByRole('dialog', { name: '会话参数', exact: true });
    await settings.getByLabel('使用历史摘要', { exact: true }).uncheck();
    await expect(settings.getByRole('status')).toHaveText('已保存');
    await settings.getByRole('button', { name: '关闭会话参数' }).click();
    await second.getByRole('button', { name: '查看上下文估算' }).click();
    await expect(second.getByRole('dialog', { name: '上下文估算', exact: true })).not.toContainText(
      '覆盖 2 条',
    );
    await second.keyboard.press('Escape');
    expect((await fixture.snapshot()).settings!.useSummaries).toBe(false);
  } finally {
    await other.close();
    await fixture.cleanup();
  }
});

test('an unknown submission result retries the same summary request and leaves a single saved summary', async ({
  page,
}) => {
  const fixture = await setup(page.request);
  try {
    await page.goto(`/c/${fixture.id}`);
    await page.getByLabel('消息', { exact: true }).fill('草稿不丢');
    await page.route(
      `**/api/conversations/${fixture.id}/messages`,
      async (route) => {
        await route.fetch();
        await route.abort('failed');
      },
      { times: 1 },
    );
    await conversationMenu(page);
    await page.getByRole('menuitem', { name: '压缩历史', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '压缩历史', exact: true });
    await modal
      .getByLabel('摘要模型', { exact: true })
      .selectOption(
        modelSelectionKey({ providerId: fixture.providerId, model: 'benchmark-summary-ok' }),
      );
    await modal.getByRole('button', { name: '生成摘要', exact: true }).click();
    await expect(page.getByText('历史摘要请求', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByText('历史摘要请求', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('summary-message')).toHaveAttribute('data-status', 'completed');
    expect((await fixture.snapshot()).messages.filter((message) => message.summary)).toHaveLength(
      1,
    );
    expect((await fixture.resources()).calls).toBe(1);
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('草稿不丢');
  } finally {
    await fixture.cleanup();
  }
});

test('summary regeneration and deletion controls keep originals and drafts, and are disabled offline', async ({
  page,
}) => {
  const fixture = await setup(page.request);
  try {
    const task = await fixture.startSummary();
    await fixture.terminal(task);
    await page.goto(`/c/${fixture.id}`);
    const composer = page.getByLabel('消息', { exact: true });
    await composer.fill('保留草稿');
    const first = page.getByTestId('summary-message').first();
    await expect(first).toHaveAttribute('data-status', 'completed');
    await page.getByTestId('branch-summaries').locator('summary').first().click();
    await first.getByRole('button', { name: '更多摘要操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '重新生成摘要', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '重新生成摘要', exact: true });
    await expect(modal.getByLabel('摘要模型', { exact: true })).toHaveValue(
      modelSelectionKey({ providerId: fixture.providerId, model: 'benchmark-summary-ok' }),
    );
    await expect(modal.getByLabel('摘要覆盖边界', { exact: true })).toHaveValue(
      fixture.seeded.messages[1].id,
    );
    await modal.getByRole('button', { name: '生成摘要', exact: true }).click();
    await expect(page.getByTestId('summary-message').nth(1)).toHaveAttribute(
      'data-status',
      'completed',
    );
    expect((await fixture.resources()).calls).toBe(2);
    await expect(composer).toHaveValue('保留草稿');
    await first.getByRole('button', { name: '更多摘要操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '删除摘要', exact: true }).click();
    const deletion = page.getByRole('alertdialog', { name: '删除摘要', exact: true });
    await expect(deletion).toContainText('原始消息仍保留');
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByTestId('summary-message').first()).toHaveText('摘要已删除或失效');
    expect((await fixture.snapshot()).messages.slice(0, 6)).toEqual(fixture.seeded.messages);
    await page.context().setOffline(true);
    await conversationMenu(page);
    await expect(page.getByRole('menuitem', { name: '压缩历史', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page
      .getByTestId('summary-message')
      .last()
      .getByRole('button', { name: '更多摘要操作', exact: true })
      .click();
    await expect(page.getByRole('menuitem', { name: '重新生成摘要', exact: true })).toBeDisabled();
    await expect(composer).toHaveValue('保留草稿');
  } finally {
    await page.context().setOffline(false);
    await fixture.cleanup();
  }
});

test('a reset interrupts partial summary work without re-calling the supplier or replacing originals', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const task = await fixture.startSummary('benchmark-summary-slow');
    await expect
      .poll(
        async () =>
          messageText(
            (await fixture.snapshot()).messages.find(({ id }) => id === task.assistantId)!,
          ).length,
      )
      .toBeGreaterThan(0);
    await request.post(`/api/__test/conversations/${fixture.id}/abort`, {
      headers,
      data: { runId: task.runId },
    });
    const interrupted = await fixture.terminal(task, 'failed');
    expect(messageText(interrupted).length).toBeGreaterThan(0);
    expect(interrupted.error).toContain('中断');
    await request.post(`/api/__test/conversations/${fixture.id}/alarm`, {
      headers,
      data: { runId: task.runId },
    });
    expect((await fixture.resources()).calls).toBe(1);
    const answer = await fixture.submit({
      content: 'next',
      parentId: fixture.seeded.messages[5].id,
    });
    expect(answer.status()).toBe(202);
    const next = (await answer.json()) as Submission;
    expect(JSON.stringify((await fixture.run(next.runId)).context)).not.toContain(
      'conversation_summary',
    );
    await fixture.stop(next.runId);
    expect((await fixture.snapshot()).messages.slice(0, 6)).toEqual(fixture.seeded.messages);
  } finally {
    await fixture.cleanup();
  }
});

test('the summary limit rejects before calling a supplier and deleting an old summary frees that quota', async ({
  request,
}) => {
  const fixture = await setup(request);
  try {
    const backup = (await request
      .get(`/api/conversations/${fixture.id}/backup`)
      .then((response) => response.json())) as EverChatBackup;
    const path = backup.conversation.messages.slice(0, 2);
    backup.conversation.messages.push(
      ...Array.from({ length: 20 }, (_, index) => ({
        ...path[1],
        id: crypto.randomUUID(),
        parts: messageParts(`摘要 ${index}`),
        createdAt: index + 20,
        parentId: path[1].id,
        summary: { throughId: path[1].id, sourceIds: path.map(({ id }) => id) },
      })),
    );
    const imported = await request.post('/api/backup/restore', { headers, data: backup });
    expect(imported.status()).toBe(201);
    const { id, snapshot } = (await imported.json()) as { id: string; snapshot: Snapshot };
    fixture.ids.push(id);
    await fixture.configure();
    const input = {
      requestId: crypto.randomUUID(),
      summaryThrough: snapshot.messages[1].id,
      selection: { providerId: fixture.providerId, model: 'benchmark-summary-ok' },
    };
    const endpoint = `/api/conversations/${id}/messages`;
    expect((await request.post(endpoint, { headers, data: input })).status()).toBe(507);
    expect(
      (
        await request
          .post(`/api/__test/conversations/${id}/resources`, { headers, data: {} })
          .then((response) => response.json())
      ).calls,
    ).toBe(0);
    expect(
      (
        await request.delete(`/api/conversations/${id}/messages/${snapshot.messages[6].id}`, {
          headers,
        })
      ).status(),
    ).toBe(200);
    const accepted = await request.post(endpoint, { headers, data: input });
    expect(accepted.status()).toBe(202);
    const task = (await accepted.json()) as Submission;
    await request.post(`/api/conversations/${id}/cancel`, { headers, data: { runId: task.runId } });
    expect(
      (
        (await request
          .get(`/api/conversations/${id}`)
          .then((response) => response.json())) as Snapshot
      ).messages.filter((message) => message.summary && !message.deletedAt),
    ).toHaveLength(20);
  } finally {
    await fixture.cleanup();
  }
});
