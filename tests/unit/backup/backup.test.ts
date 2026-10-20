import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupMessage,
  validateBackup,
} from '../../../shared/backup/backup';
import { messageParts, messageText } from '../../../shared/conversation/content';
import { DEFAULT_CONVERSATION_SETTINGS } from '../../../shared/conversation/settings';
import type { Message } from '../../../shared/conversation/types';
import { ProviderStream } from '../../../shared/streaming/provider-stream';
import { planConversationRestore } from '../../../worker/backup/restore-plan';
import {
  MAX_MESSAGE_TEXT_BYTES,
  MAX_SYSTEM_PROMPT_LENGTH,
} from '../../../shared/conversation/limits';

const assistant: Message = {
  id: crypto.randomUUID(),
  role: 'assistant',
  parts: messageParts('已保存的回答', '思考过程'),
  status: 'running',
  createdAt: 2,
  runId: crypto.randomUUID(),
  parentId: crypto.randomUUID(),
  revisionOf: null,
  error: null,
  providerId: crypto.randomUUID(),
  model: 'deepseek-flash',
  modelName: 'DeepSeek Flash',
  durableOffset: 18,
  liveOffset: 24,
};

test('backupMessage converts an unfinished generation into recoverable partial content and strips stream state', () => {
  const result = backupMessage(assistant);
  assert.equal(result.status, 'failed');
  assert.equal(messageText(result), messageText(assistant));
  assert.equal(messageText(result, 'reasoning'), messageText(assistant, 'reasoning'));
  assert.match(result.error ?? '', /尚未完成/);
  assert.equal('runId' in result, false);
  assert.equal('durableOffset' in result, false);
  assert.equal(result.modelName, 'DeepSeek Flash');
});

test('a message tombstone preserves graph identity without exporting deleted text or thoughts', () => {
  const result = backupMessage({ ...assistant, status: 'completed', deletedAt: 123 });
  assert.equal(result.deletedAt, 123);
  assert.equal(result.id, assistant.id);
  assert.equal(result.parentId, assistant.parentId);
  assert.equal(messageText(result), '');
  assert.deepEqual(result.parts, []);
});

test('an unfinished backup retains only the supplier usage observed in its durable stream prefix', () => {
  const parser = new ProviderStream('anthropic', false);
  parser.feed(
    new TextEncoder().encode(
      '{"type":"usage","usage":{"inputTokens":5,"uncachedInputTokens":3,"cacheWriteInputTokens":2}}\n',
    ),
  );
  const result = backupMessage({ ...assistant, streamState: parser.checkpoint() });
  assert.deepEqual(result.generation, {
    usage: { inputTokens: 5, uncachedInputTokens: 3, cacheWriteInputTokens: 2 },
    usageIsFinal: false,
  });
  assert.equal(Object.hasOwn(result.generation!.usage, 'outputTokens'), false);
  assert.equal(Object.hasOwn(result.generation!, 'timing'), false);
});

test('validateBackup accepts version 1 backups and rejects malformed messages', () => {
  const id = crypto.randomUUID();
  const backup = validateBackup({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    conversation: {
      id,
      title: '测试备份',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          parts: messageParts('正文', '思考'),
          status: 'completed',
          createdAt: 2,
          parentId: null,
          revisionOf: null,
          error: null,
          providerId: null,
          model: null,
          modelName: null,
        },
      ],
    },
    settings: {
      providers: [
        {
          id: crypto.randomUUID(),
          name: '测试供应商',
          provider: 'openai-chat',
          baseUrl: 'https://provider.example/v1',
          models: [{ id: 'test', name: 'Test', enabled: true }],
        },
      ],
      activeProviderId: null,
      activeModel: '',
      systemPrompt: '',
      maxOutputTokens: null,
      promptPresets: [],
    },
  });
  assert.equal(backup.conversation.title, '测试备份');
  assert.equal(messageText(backup.conversation.messages[0], 'reasoning'), '思考');
  const saved = backup.conversation.messages[0];
  assert.deepEqual(saved.parts, messageParts('正文', '思考'));
  assert.equal('content' in saved || 'reasoning' in saved, false);
  const large = validateBackup({
    ...backup,
    conversation: {
      ...backup.conversation,
      settings: {
        ...DEFAULT_CONVERSATION_SETTINGS,
        systemPrompt: '\u0000'.repeat(MAX_SYSTEM_PROMPT_LENGTH),
      },
      messages: [{ ...saved, parts: messageParts('x'.repeat(MAX_MESSAGE_TEXT_BYTES)) }],
    },
    settings: { ...backup.settings, maxOutputTokens: 200_000 },
  });
  const plan = planConversationRestore(large.conversation);
  assert.ok(!('error' in plan));
  const eventBytes = new TextEncoder().encode(
    JSON.stringify({ messages: plan.batches[0], settings: plan.settings }),
  ).byteLength;
  assert.ok(eventBytes > 1_000_000 && eventBytes < 1_900_000);
  for (const invalid of [
    { ...saved, content: 'old shape', reasoning: 'old shape' },
    { ...saved, role: 'user' },
    {
      ...saved,
      parts: [
        { type: 'text', text: 'x' },
        { type: 'text', text: 'y' },
      ],
    },
    { ...saved, parts: [{ type: 'image', url: 'https://example.com/image.png' }] },
    { ...saved, parts: [{ type: 'text', text: 'x', apiKey: 'secret' }] },
  ])
    assert.throws(
      () =>
        validateBackup({
          ...backup,
          conversation: { ...backup.conversation, messages: [invalid] },
        }),
      /消息字段无效/,
    );
  const deleted = validateBackup({
    ...backup,
    conversation: {
      ...backup.conversation,
      messages: [{ ...saved, deletedAt: 123, error: 'private error' }],
    },
  }).conversation.messages[0];
  assert.deepEqual(deleted.parts, []);
  assert.equal(deleted.error, null);
  assert.throws(
    () =>
      validateBackup({
        ...backup,
        conversation: {
          ...backup.conversation,
          messages: [{ ...backup.conversation.messages[0], status: 'running' }],
        },
      }),
    /消息字段无效/,
  );
  assert.throws(() => validateBackup({ ...backup, version: 2 }), /版本不受支持/);
  const settings = {
    ...DEFAULT_CONVERSATION_SETTINGS,
    systemPrompt: '会话提示',
    useGlobalMaxOutputTokens: false,
  };
  assert.deepEqual(
    validateBackup({ ...backup, conversation: { ...backup.conversation, settings } }).conversation
      .settings,
    settings,
  );
  assert.throws(
    () =>
      validateBackup({
        ...backup,
        conversation: { ...backup.conversation, settings: { ...settings, temperature: 8 } },
      }),
    /会话参数无效/,
  );
  const preset = {
    id: crypto.randomUUID(),
    name: '写作',
    systemPrompt: '你是写作助手。',
    updatedAt: 1,
  };
  const generation = {
    usage: { inputTokens: 0, outputTokens: 7, reasoningTokens: 2 },
    usageIsFinal: true,
    timing: { queueMs: 0, firstTokenMs: 100, durationMs: 500 },
  };
  const withGeneration = {
    ...backup,
    conversation: {
      ...backup.conversation,
      messages: [{ ...backup.conversation.messages[0], generation }],
    },
  };
  assert.deepEqual(validateBackup(withGeneration).conversation.messages[0].generation, generation);
  assert.equal(
    backupMessage({ ...assistant, status: 'completed', deletedAt: 123, generation }).generation,
    undefined,
  );
  assert.equal(
    validateBackup({
      ...withGeneration,
      conversation: {
        ...withGeneration.conversation,
        messages: [{ ...withGeneration.conversation.messages[0], deletedAt: 123 }],
      },
    }).conversation.messages[0].generation,
    undefined,
  );
  for (const invalid of [
    { ...generation, usage: { outputTokens: -1 } },
    { ...generation, apiKey: 'unexpected' },
  ])
    assert.throws(
      () =>
        validateBackup({
          ...withGeneration,
          conversation: {
            ...withGeneration.conversation,
            messages: [{ ...withGeneration.conversation.messages[0], generation: invalid }],
          },
        }),
      /生成元数据无效/,
    );
  assert.deepEqual(
    validateBackup({ ...backup, settings: { ...backup.settings, promptPresets: [preset] } })
      .settings.promptPresets,
    [preset],
  );
  assert.throws(
    () =>
      validateBackup({
        ...backup,
        settings: { ...backup.settings, promptPresets: [preset, preset] },
      }),
    /提示词预设无效/,
  );
  assert.throws(
    () =>
      validateBackup({
        ...backup,
        settings: { ...backup.settings, promptPresets: [{ ...preset, apiKey: 'unexpected' }] },
      }),
    /提示词预设无效/,
  );
});

test('tool process backups retain safe outcomes, stop unfinished work and reject private or mismatched records', () => {
  const completed = {
    round: 0,
    call: { id: 'search-0', name: 'web_search' as const, input: { query: 'Cloudflare' } },
    state: 'completed' as const,
    result: {
      id: 'search-0',
      name: 'web_search' as const,
      status: 'completed' as const,
      sources: [{ title: '文档', url: 'https://developers.cloudflare.com/', content: '公开结果' }],
    },
  };
  const running = {
    round: 0,
    call: {
      id: 'read-0',
      name: 'read_webpage' as const,
      input: { url: 'https://developers.cloudflare.com/' },
    },
    state: 'running' as const,
  };
  const partial = backupMessage({
    ...assistant,
    parentId: null,
    tools: {
      status: 'active',
      round: 0,
      calls: [completed, running],
      reasoningBreaks: [{ round: 0, reasoningEnd: 2 }],
    },
  });
  assert.deepEqual(partial.tools, {
    status: 'failed',
    round: 0,
    calls: [completed, { ...running, state: 'cancelled' }],
    reasoningBreaks: [{ round: 0, reasoningEnd: 2 }],
  });
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    conversation: {
      id: crypto.randomUUID(),
      title: '工具备份',
      createdAt: 1,
      updatedAt: 2,
      messages: [partial],
    },
    settings: {
      providers: [],
      activeProviderId: null,
      activeModel: '',
      systemPrompt: '',
      maxOutputTokens: null,
      promptPresets: [],
    },
  };
  assert.deepEqual(
    validateBackup(JSON.parse(JSON.stringify(backup))).conversation.messages[0].tools,
    partial.tools,
  );
  const retained = {
    ...partial,
    status: 'completed',
    generation: { usage: {}, usageIsFinal: false, interrupted: true },
  };
  const retainedBackup = {
    ...backup,
    conversation: { ...backup.conversation, messages: [retained] },
  };
  assert.deepEqual(validateBackup(retainedBackup).conversation.messages[0], retained);
  assert.throws(
    () =>
      validateBackup({
        ...retainedBackup,
        conversation: { ...backup.conversation, messages: [{ ...retained, parts: [] }] },
      }),
    /保留回答无效/,
  );
  const invalid = [
    { ...partial.tools, status: 'active' },
    { ...partial.tools, providerOptions: { signature: 'private' } },
    { ...partial.tools, calls: [completed, completed] },
    { ...partial.tools, calls: [{ ...completed, round: 1 }] },
    {
      ...partial.tools,
      calls: [{ ...completed, result: { ...completed.result, id: 'another-call' } }],
    },
    {
      ...partial.tools,
      calls: [{ ...completed, result: { ...completed.result, signature: 'private' } }],
    },
    { ...partial.tools, calls: [{ ...completed, state: 'running' }] },
    { ...partial.tools, reasoningBreaks: [{ round: 0, reasoningEnd: 5 }] },
    { ...partial.tools, reasoningBreaks: [] },
    {
      ...partial.tools,
      calls: [
        {
          ...completed,
          result: {
            ...completed.result,
            sources: [{ ...completed.result.sources[0], url: 'https://localhost/' }],
          },
        },
      ],
    },
  ];
  for (const tools of invalid)
    assert.throws(
      () =>
        validateBackup({
          ...backup,
          conversation: { ...backup.conversation, messages: [{ ...partial, tools }] },
        }),
      /工具过程无效/,
    );
  assert.equal(
    backupMessage({
      ...assistant,
      tools: { status: 'active', round: 0, calls: [completed] },
      deletedAt: 123,
    }).tools,
    undefined,
  );
});
