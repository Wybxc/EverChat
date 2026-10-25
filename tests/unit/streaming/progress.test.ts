import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  GenerationProgressStore,
  GENERATION_PROGRESS_SCHEMA,
} from '../../../worker/generation/progress';
import type { SqlQuery } from '../../../worker/generation/metrics';

test('generation progress changes only for business transitions and semantic checkpoints, and survives a fresh reader', () => {
  const db = new DatabaseSync(':memory:');
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) => {
    const rows = db.prepare(sql).all(...(args as (string | number | null)[])) as T[];
    return {
      toArray: () => rows,
      one: () => {
        assert.equal(rows.length, 1);
        return rows[0];
      },
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
  };
  let now = 100;
  const progress = new GenerationProgressStore(query, () => now);
  const changes = () => query<{ count: number }>('SELECT total_changes() AS count').one().count;
  try {
    query(GENERATION_PROGRESS_SCHEMA);
    progress.begin('answer', now);
    assert.equal(progress.get('answer')?.phase, 'queued');
    now = 200;
    progress.phase('answer', 'preparing');
    now = 300;
    progress.phase('answer', 'waiting_provider', true);
    const before = changes();
    now = 1000;
    for (let index = 0; index < 5; index++) {
      progress.get('answer');
      progress.phase('answer', 'waiting_provider');
      progress.content('answer', {
        content: { length: 0, replaced: false },
        reasoning: { length: 0, replaced: false },
      });
    }
    assert.equal(changes(), before, 'polls, duplicate transitions and keepalives must not write');
    assert.equal(progress.get('answer')?.lastProgressAt, 300);
    now = 2000;
    progress.content('answer', {
      content: { length: 0, replaced: false },
      reasoning: { length: 20, replaced: false },
    });
    const first = progress.get('answer')!;
    assert.equal(first.phase, 'generating');
    assert.equal(first.firstContentAt, 2000);
    assert.equal(first.reasoning.length, 20);
    assert.equal(first.content.length, 0);
    now = 3000;
    progress.content('answer', {
      content: { length: 10, replaced: false },
      reasoning: { length: 20, replaced: true },
    });
    const changed = new GenerationProgressStore(query).get('answer')!;
    assert.equal(changed.firstContentAt, 2000);
    assert.equal(changed.reasoning.epoch, 1);
    assert.equal(changed.content.epoch, 0);
    assert.equal(changed.lastContentAt, 3000);
    assert.ok(changed.revision > first.revision);
    progress.phase('answer', 'waiting_tools');
    progress.phase('answer', 'queued');
    progress.phase('answer', 'preparing');
    progress.phase('answer', 'waiting_provider', true);
    assert.equal(progress.get('answer')?.acceptedAt, 100);
    progress.phase('answer', 'finalizing');
    progress.phase('answer', null);
    assert.equal(progress.get('answer')?.phase, null);
    assert.equal(progress.get('missing'), null);
    progress.content('missing', {
      content: { length: 10, replaced: false },
      reasoning: { length: 0, replaced: false },
    });
    assert.equal(
      progress.get('missing'),
      null,
      'do not invent progress for old or deleted records',
    );
    progress.erase('answer');
    assert.equal(progress.get('answer'), null);
  } finally {
    db.close();
  }
});
