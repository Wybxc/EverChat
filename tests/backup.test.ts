import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT, BACKUP_VERSION, backupMessage, validateBackup } from '../shared/backup';
import type { Message } from '../shared/types';
import { DEFAULT_CONVERSATION_SETTINGS } from '../shared/conversation-settings';
import { ProviderStream } from '../shared/provider-stream';

const assistant: Message = {
  id: crypto.randomUUID(), role: 'assistant', content: '已保存的回答', reasoning: '思考过程', status: 'running', createdAt: 2,
  runId: crypto.randomUUID(), parentId: crypto.randomUUID(), revisionOf: null, error: null,
  providerId: crypto.randomUUID(), model: 'deepseek-flash', modelName: 'DeepSeek Flash', durableOffset: 18, liveOffset: 24,
};

test('backupMessage converts an unfinished generation into recoverable partial content and strips stream state', () => {
  const result = backupMessage(assistant);
  assert.equal(result.status, 'failed');
  assert.equal(result.content, assistant.content);
  assert.equal(result.reasoning, assistant.reasoning);
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
  assert.equal(result.content, '');
  assert.equal(result.reasoning, null);
});

test('an unfinished backup retains only the supplier usage observed in its durable stream prefix', () => {
  const parser = new ProviderStream('anthropic', false);
  parser.feed(new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_creation_input_tokens":2}}}\n\n'));
  const result = backupMessage({ ...assistant, streamState: parser.checkpoint() });
  assert.deepEqual(result.generation, { usage: { inputTokens: 5, uncachedInputTokens: 3, cacheWriteInputTokens: 2 }, usageIsFinal: false });
  assert.equal(Object.hasOwn(result.generation!.usage, 'outputTokens'), false); assert.equal(Object.hasOwn(result.generation!, 'timing'), false);
});

test('validateBackup accepts version 1 backups and rejects malformed messages', () => {
  const id = crypto.randomUUID();
  const backup = validateBackup({
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: Date.now(),
    conversation: { id, title: '测试备份', createdAt: 1, updatedAt: 2, messages: [{
      id: crypto.randomUUID(), role: 'assistant', content: '正文', reasoning: '思考', status: 'completed', createdAt: 2,
      parentId: null, revisionOf: null, error: null, providerId: null, model: null, modelName: null,
    }] },
    settings: { providers: [{ id: crypto.randomUUID(), name: '测试供应商', provider: 'openai-chat', baseUrl: 'https://provider.example/v1', models: [{ id: 'test', name: 'Test', enabled: true }] }], activeProviderId: null, activeModel: '', systemPrompt: '', maxOutputTokens: null, showReasoning: true, promptPresets: [] },
  });
  assert.equal(backup.conversation.title, '测试备份');
  assert.equal(backup.conversation.messages[0].reasoning, '思考');
  assert.throws(() => validateBackup({ ...backup, conversation: { ...backup.conversation, messages: [{ ...backup.conversation.messages[0], status: 'running' }] } }), /消息字段无效/);
  assert.throws(() => validateBackup({ ...backup, version: 2 }), /版本不受支持/);
  const settings = { ...DEFAULT_CONVERSATION_SETTINGS, systemPrompt: '会话提示', useGlobalMaxOutputTokens: false };
  assert.deepEqual(validateBackup({ ...backup, conversation: { ...backup.conversation, settings } }).conversation.settings, settings);
  assert.throws(() => validateBackup({ ...backup, conversation: { ...backup.conversation, settings: { ...settings, temperature: 8 } } }), /会话参数无效/);
  const preset = { id: crypto.randomUUID(), name: '写作', systemPrompt: '你是写作助手。', updatedAt: 1 };
  const generation = { usage: { inputTokens: 0, outputTokens: 7, reasoningTokens: 2 }, usageIsFinal: true, timing: { queueMs: 0, firstTokenMs: 100, durationMs: 500 } };
  const withGeneration = { ...backup, conversation: { ...backup.conversation, messages: [{ ...backup.conversation.messages[0], generation }] } };
  assert.deepEqual(validateBackup(withGeneration).conversation.messages[0].generation, generation);
  assert.equal(backupMessage({ ...assistant, status: 'completed', deletedAt: 123, generation }).generation, undefined);
  assert.equal(validateBackup({ ...withGeneration, conversation: { ...withGeneration.conversation, messages: [{ ...withGeneration.conversation.messages[0], deletedAt: 123 }] } }).conversation.messages[0].generation, undefined);
  for (const invalid of [{ ...generation, usage: { outputTokens: -1 } }, { ...generation, apiKey: 'unexpected' }]) assert.throws(() => validateBackup({ ...withGeneration, conversation: { ...withGeneration.conversation, messages: [{ ...withGeneration.conversation.messages[0], generation: invalid }] } }), /生成元数据无效/);
  assert.deepEqual(validateBackup({ ...backup, settings: { ...backup.settings, promptPresets: [preset] } }).settings.promptPresets, [preset]);
  assert.throws(() => validateBackup({ ...backup, settings: { ...backup.settings, promptPresets: [preset, preset] } }), /提示词预设无效/);
  assert.throws(() => validateBackup({ ...backup, settings: { ...backup.settings, promptPresets: [{ ...preset, apiKey: 'unexpected' }] } }), /提示词预设无效/);
});
