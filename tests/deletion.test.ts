import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamSync } from '../shared/stream-sync';
import { cachedSnapshot, deletedAt, markConversationDeleted, read, write } from '../src/storage';

test('a confirmed deletion removes saved and preview contents and rejects delayed snapshots', () => {
  const before = { messages: [{ id: 'message', role: 'assistant' as const, content: 'saved', status: 'completed' as const,
    createdAt: 1, runId: null, parentId: null, revisionOf: null, error: null }], seq: 2 };
  const sync = new StreamSync(before);
  assert.equal(sync.receive({ type: 'deleted', deletedAt: 100 }), true);
  assert.deepEqual(sync.view, { messages: [], seq: 2, deletedAt: 100 });
  assert.equal(sync.hasPreview, false);
  assert.equal(sync.receive({ type: 'snapshot', snapshot: before }), false);
  assert.equal(sync.receive({ type: 'ready', seq: 2 }), false);
  assert.deepEqual(sync.durable.messages, []);
});

test('a deletion marker prevents a delayed cache write or draft from restoring a deleted conversation', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), fallback = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => fallback.get(key) ?? null, setItem: (key: string, value: string) => fallback.set(key, value), removeItem: (key: string) => fallback.delete(key),
  } });
  try {
  const id = crypto.randomUUID();
  write(`draft:${id}`, { text: 'old draft' });
  markConversationDeleted(id, 100);
  write(`snapshot:${id}`, { messages: ['stale body'], seq: 5 });
  write(`draft:${id}`, { text: 'stale draft' });
  assert.equal(deletedAt(id), 100);
  assert.deepEqual(cachedSnapshot(id), { messages: [], seq: 0, deletedAt: 100 });
  assert.deepEqual(read(`draft:${id}`, { text: '' }), { text: '' });
  assert.equal(fallback.has(`everchat:draft:${id}`), false);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
