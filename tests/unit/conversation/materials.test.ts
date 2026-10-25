import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { materialContext } from '../../../shared/conversation/materials';
import { prepareChatContext, summaryGeneration } from '../../../shared/conversation/summaries';
import { DEFAULT_CONVERSATION_SETTINGS as settings } from '../../../shared/conversation/settings';
import type { Message } from '../../../shared/conversation/types';
import type { DocumentPart } from '../../../shared/attachments/documents';
import type { ProviderConfig } from '../../../shared/providers/types';
import { resolveModelMetadata } from '../../../shared/models/metadata';
const documentId = crypto.randomUUID();
function file(text: string, mode: 'reuse' | 'replace' | 'include_both' = 'reuse'): DocumentPart {
  const id = crypto.randomUUID(),
    hash = createHash('sha256').update(text).digest('hex');
  return {
    type: 'file',
    attachmentId: id,
    name: '1021.typ',
    mediaType: 'text/plain',
    size: text.length,
    sha256: hash,
    textSha256: hash,
    version: 1,
    characters: text.length,
    tokens: 200,
    material: { documentId, versionId: id, mode, supersedes: null },
  };
}
function turn(parentId: string | null, f?: DocumentPart): Message[] {
  const user: Message = {
    id: crypto.randomUUID(),
    parentId,
    role: 'user',
    status: 'completed',
    parts: [{ type: 'text', text: 'question' }, ...(f ? [f] : [])],
    createdAt: 1,
    runId: null,
    revisionOf: null,
    error: null,
  };
  return [
    user,
    {
      ...user,
      id: crypto.randomUUID(),
      parentId: user.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'answer' }],
    },
  ];
}
const config: ProviderConfig = {
  provider: 'openai-chat',
  model: 'text',
  baseUrl: 'https://provider.test/v1',
  apiKey: 'unused',
  systemPrompt: '',
  maxOutputTokens: null,
  modelMetadata: resolveModelMetadata('openai-chat', {
    id: 'text',
    name: '',
    enabled: true,
    metadataOverrides: { contextWindow: 2000 },
  }),
};
test('material replacement removes old blocks, pins selected versions beyond history limits and isolates sibling branches', () => {
  const v1 = file('old'),
    v2 = file('new', 'replace'),
    first = turn(null, v1),
    second = turn(first[1].id, v2),
    messages = [...first, ...second];
  const prepared = prepareChatContext(messages, second[1].id, 'next', config, {
    ...settings,
    recentMessages: 0,
  });
  assert.deepEqual(
    prepared.messages.flatMap((m) => m.files ?? []).map((f) => f.attachmentId),
    [v2.attachmentId],
  );
  assert(
    prepared.selection.omitted.some(
      (e) => e.reason === 'superseded_file' && e.input.files?.[0].attachmentId === v1.attachmentId,
    ),
  );
  assert.equal(
    materialContext(messages, first[1].id).pinned[0].files![0].attachmentId,
    v1.attachmentId,
  );
  assert.equal(messages[0].parts[1], v1);
  const summary = summaryGeneration(messages, second[1].id, config);
  assert.deepEqual(summary.coverage.materials, materialContext(messages, second[1].id).versions);
});
test('replacement invalidates summaries based on old versions; include_both and exact reuse preserve explicit materials', () => {
  const v1 = file('old'),
    v2 = file('new', 'replace'),
    first = turn(null, v1);
  const summary: Message = {
    ...first[1],
    id: crypto.randomUUID(),
    parts: [{ type: 'text', text: 'old summary' }],
    summary: {
      throughId: first[1].id,
      sourceIds: first.map((m) => m.id),
      materials: [{ documentId, versionId: v1.attachmentId, textSha256: v1.textSha256 }],
    },
  };
  const result = materialContext([...first, summary], first[1].id, [v2]);
  assert.deepEqual(result.invalidatedSummaries, [summary.id]);
  assert.equal(result.messages.find((m) => m.id === summary.id)!.status, 'failed');
  assert.equal(summary.status, 'completed');
  const second = turn(first[1].id, v2),
    messages = [...first, ...second];
  assert.throws(() => materialContext(messages, second[1].id, [v1]), /其他活动版本/);
  const both = materialContext(messages, second[1].id, [
    { ...v1, material: { ...v1.material!, mode: 'include_both' } },
  ]);
  assert.deepEqual(
    new Set(both.pinned.map((m) => m.files![0].attachmentId)),
    new Set([v1.attachmentId, v2.attachmentId]),
  );
  assert.throws(() => materialContext(messages, first[1].id, [v1, v2]), /多个版本/);
});
test('pinned material is never silently truncated to satisfy the context budget and deleted source messages do not activate files', () => {
  const first = turn(null, file('large'));
  assert.throws(
    () =>
      prepareChatContext(first, first[1].id, 'next', config, { ...settings, contextBudget: 100 }),
    /预算/,
  );
  const deleted = first.map((m, i) => (i === 0 ? { ...m, deletedAt: 2 } : m));
  assert.equal(materialContext(deleted, first[1].id).pinned.length, 0);
});
