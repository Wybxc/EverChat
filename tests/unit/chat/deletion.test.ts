import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageParts } from '../../../shared/conversation/content';
import { StreamSync } from '../../../shared/streaming/sync';
import {
  cachedSnapshot,
  deletedAt,
  markConversationDeleted,
  writeChatCache as write,
} from '../../../src/features/chat/cache';
import { read } from '../../../src/platform/storage';

test('a confirmed deletion removes saved and preview contents and rejects delayed snapshots', () => {
  const before = {
    messages: [
      {
        id: 'message',
        role: 'assistant' as const,
        parts: messageParts('saved'),
        status: 'completed' as const,
        createdAt: 1,
        runId: null,
        parentId: null,
        revisionOf: null,
        error: null,
      },
    ],
    seq: 2,
  };
  const sync = new StreamSync(before);
  assert.equal(sync.receive({ type: 'deleted', deletedAt: 100 }), true);
  assert.deepEqual(sync.view, { messages: [], seq: 2, deletedAt: 100 });
  assert.equal(sync.hasPreview, false);
  assert.equal(sync.receive({ type: 'snapshot', snapshot: before }), false);
  assert.equal(sync.receive({ type: 'ready', seq: 2 }), false);
  assert.deepEqual(sync.durable.messages, []);
});

test('a deletion marker prevents a delayed cache write or draft from restoring a deleted conversation', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    fallback = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => fallback.get(key) ?? null,
      setItem: (key: string, value: string) => fallback.set(key, value),
      removeItem: (key: string) => fallback.delete(key),
    },
  });
  try {
    const id = crypto.randomUUID();
    write(`draft:${id}`, { text: 'old draft' });
    write(`message-edit:${id}`, { content: 'old edit' });
    write(`chat-model:${id}`, '["provider","old-model"]');
    write(`conversation-settings-draft:${id}`, {
      settings: { systemPrompt: 'old private prompt' },
      dirty: true,
    });
    markConversationDeleted(id, 100);
    write(`snapshot:${id}`, { messages: ['stale body'], seq: 5 });
    write(`draft:${id}`, { text: 'stale draft' });
    write(`message-edit:${id}`, { content: 'stale edit' });
    write(`chat-model:${id}`, '["provider","stale-model"]');
    write(`conversation-settings-draft:${id}`, {
      settings: { systemPrompt: 'stale private prompt' },
      dirty: true,
    });
    assert.equal(deletedAt(id), 100);
    assert.deepEqual(cachedSnapshot(id), { messages: [], seq: 0, deletedAt: 100 });
    assert.deepEqual(read(`draft:${id}`, { text: '' }), { text: '' });
    assert.equal(fallback.has(`everchat:draft:${id}`), false);
    assert.equal(read(`message-edit:${id}`, null), null);
    assert.equal(fallback.has(`everchat:message-edit:${id}`), false);
    assert.equal(read(`chat-model:${id}`, null), null);
    assert.equal(fallback.has(`everchat:chat-model:${id}`), false);
    assert.equal(read(`conversation-settings-draft:${id}`, null), null);
    assert.equal(fallback.has(`everchat:conversation-settings-draft:${id}`), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
