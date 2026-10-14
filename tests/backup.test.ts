import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT, BACKUP_VERSION, backupMessage, validateBackup } from '../shared/backup';
import type { Message } from '../shared/types';

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

test('validateBackup accepts version 1 backups and rejects malformed messages', () => {
  const id = crypto.randomUUID();
  const backup = validateBackup({
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: Date.now(),
    conversation: { id, title: '测试备份', createdAt: 1, updatedAt: 2, messages: [{
      id: crypto.randomUUID(), role: 'assistant', content: '正文', reasoning: '思考', status: 'completed', createdAt: 2,
      parentId: null, revisionOf: null, error: null, providerId: null, model: null, modelName: null,
    }] },
    settings: { providers: [{ id: crypto.randomUUID(), name: '测试供应商', provider: 'openai-chat', baseUrl: 'https://provider.example/v1', models: [{ id: 'test', name: 'Test', enabled: true }] }], activeProviderId: null, activeModel: '', systemPrompt: '', maxOutputTokens: null, showReasoning: true },
  });
  assert.equal(backup.conversation.title, '测试备份');
  assert.equal(backup.conversation.messages[0].reasoning, '思考');
  assert.throws(() => validateBackup({ ...backup, conversation: { ...backup.conversation, messages: [{ ...backup.conversation.messages[0], status: 'running' }] } }), /消息字段无效/);
  assert.throws(() => validateBackup({ ...backup, version: 2 }), /版本不受支持/);
});
