import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadLibraryIndex } from '../../../src/features/library/index-cache';
import { coversLibraryVersion } from '../../../shared/library/protocol';
import type { LibrarySnapshot } from '../../../shared/conversation/types';

const snapshot = (): LibrarySnapshot => ({
  watermark: { epoch: 'current', revision: 10 },
  conversations: [{ id: 'a', title: 'A', createdAt: 1, updatedAt: 1, pinned: false }],
  activity: {},
  deletions: [],
  deletionCursor: 0,
  hasMoreDeletions: false,
});
test('deletion pagination fetches the full index once and atomically excludes later tombstones', async () => {
  const first = {
    ...snapshot(),
    deletions: [{ id: 'old', deletedAt: 1 }],
    deletionCursor: 256,
    hasMoreDeletions: true,
  };
  const paths: string[] = [];
  const loaded = await loadLibraryIndex(
    null,
    new AbortController().signal,
    async <T>(path: string) => {
      paths.push(path);
      return (
        paths.length === 1
          ? first
          : { deletions: [{ id: 'a', deletedAt: 2 }], deletionCursor: 257, hasMoreDeletions: false }
      ) as T;
    },
  );
  assert.deepEqual(paths, ['/conversations?after=0', '/conversations/deletions?after=256']);
  assert.equal(loaded.conversations.length, 0);
  assert.equal(loaded.deletionCursor, 257);
  assert.deepEqual(loaded.watermark, first.watermark);
});
test('a new epoch resets deletion pagination and cannot be hidden by a greater old revision', async () => {
  const cached = { ...snapshot(), watermark: { epoch: 'old', revision: 100 }, deletionCursor: 500 };
  const paths: string[] = [];
  const loaded = await loadLibraryIndex(
    cached,
    new AbortController().signal,
    async <T>(path: string) => {
      paths.push(path);
      return (
        paths.length === 1
          ? snapshot()
          : { deletions: [], deletionCursor: 0, hasMoreDeletions: false }
      ) as T;
    },
  );
  assert.deepEqual(paths, ['/conversations?after=500', '/conversations/deletions?after=0']);
  assert.equal(loaded.deletionCursor, 0);
  assert.equal(coversLibraryVersion(cached.watermark, loaded.watermark), false);
  assert.equal(coversLibraryVersion({ epoch: 'current', revision: 11 }, loaded.watermark), true);
});
test('failed or non-progressing deletion pages never publish an advanced cached cursor', async () => {
  const cached = snapshot();
  let calls = 0;
  await assert.rejects(
    loadLibraryIndex(cached, new AbortController().signal, async <T>() => {
      calls++;
      return { ...snapshot(), hasMoreDeletions: true } as T;
    }),
    /Invalid deletion cursor/,
  );
  assert.equal(calls, 2);
  assert.equal(cached.deletionCursor, 0);
});
