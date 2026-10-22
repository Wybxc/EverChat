import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { cleanTitle } from '../../../shared/conversation/titles';
import type { ProviderConfig } from '../../../shared/providers/types';
import { ConversationTitles, TITLE_JOBS_SCHEMA } from '../../../worker/conversation/titles';
import { LibraryTitles, TITLE_INDEX_SCHEMA } from '../../../worker/library/titles';
import type { SqlQuery } from '../../../worker/generation/metrics';

const config: ProviderConfig = {
  provider: 'openai-chat',
  baseUrl: 'https://provider.test/v1',
  model: 'title-model',
  apiKey: 'secret',
  systemPrompt: 'title-only',
  maxOutputTokens: 128,
};
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    TITLE_JOBS_SCHEMA +
      TITLE_INDEX_SCHEMA +
      'CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT);',
  );
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...bindings: SqlStorageValue[]
  ) => {
    const rows = db.prepare(sql).all(...(bindings as (string | number | null)[])) as T[];
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
  let now = 1000,
    live = true;
  const jobs = new ConversationTitles(
    query,
    () => live,
    () => now,
  );
  const titles = new LibraryTitles(query);
  query('INSERT INTO conversations VALUES (?,?)', 'chat', 'fallback');
  titles.create('chat', 'fallback');
  const library = {
    reserveTitle: async (id: string, taskId: string, auto: boolean, expected: number) =>
      titles.reserve(id, taskId, auto, expected),
    startTitle: async (id: string, taskId: string, version: number) =>
      titles.running(id, taskId, version),
    finishTitle: async (
      id: string,
      taskId: string,
      version: number,
      title: string | null,
      error?: string,
    ) => titles.finish(id, taskId, version, title, error),
  };
  return {
    db,
    query,
    jobs,
    titles,
    library,
    tick: (value: number) => {
      now = value;
    },
    kill: () => {
      live = false;
    },
  };
}
function body(value = '"一个标题"') {
  return { text: value, finishReason: 'stop' as const, usage: {}, usageIsFinal: true };
}

test('automatic titles are opt-in, bounded, frozen, and attempted only once', () => {
  const s = fixture();
  try {
    s.jobs.initialize(null);
    s.jobs.offerAutomatic('chat', 'question', 'answer');
    assert.equal(s.jobs.nextAlarm(), null);
    s.query('DELETE FROM title_automatic');
    s.jobs.initialize(config);
    config.model = 'changed-after-acceptance';
    s.jobs.offerAutomatic('chat', 'q'.repeat(4000), 'a'.repeat(8000));
    s.jobs.offerAutomatic('chat', 'another question', 'another answer');
    const rows = s
      .query<{ config: string; input: string }>('SELECT config,input FROM title_jobs')
      .toArray();
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].config).model, 'title-model');
    const input = JSON.parse(JSON.parse(rows[0].input)[0].content);
    assert.equal(input.question.length, 2000);
    assert.equal(input.answer.length, 4000);
    assert.equal(
      s.query<{ config: string | null }>('SELECT config FROM title_automatic').one().config,
      null,
    );
  } finally {
    config.model = 'title-model';
    s.db.close();
  }
});

test('chat runs first; lost reservation and result acknowledgements never duplicate the supplier call', async () => {
  const s = fixture();
  let calls = 0,
    reserveLost = true,
    resultLost = true;
  try {
    s.jobs.enqueue('chat', 'job', config, 'question', 'answer');
    const library = {
      ...s.library,
      reserveTitle: async (...args: Parameters<typeof s.library.reserveTitle>) => {
        const value = await s.library.reserveTitle(...args);
        if (reserveLost) {
          reserveLost = false;
          throw Error('lost reservation');
        }
        return value;
      },
      finishTitle: async (...args: Parameters<typeof s.library.finishTitle>) => {
        const value = await s.library.finishTitle(...args);
        if (resultLost) {
          resultLost = false;
          throw Error('lost ack');
        }
        return value;
      },
    };
    const open = async () => {
      calls++;
      return body();
    };
    await s.jobs.step(
      library,
      async () => {},
      open,
      () => true,
    );
    assert.equal(calls, 0);
    s.tick(2000);
    await s.jobs.step(
      library,
      async () => {},
      open,
      () => false,
    );
    assert.equal(calls, 0);
    s.tick(4000);
    await s.jobs.step(
      library,
      async () => {},
      open,
      () => false,
    );
    assert.equal(calls, 1);
    assert.equal(s.jobs.get('job')?.state, 'delivering');
    assert.equal(s.jobs.get('job')?.config, null);
    assert.equal(
      s.query<{ title: string }>('SELECT title FROM conversations').one().title,
      '一个标题',
    );
    const recovered = new ConversationTitles(
      s.query,
      () => true,
      () => 100_000,
    );
    recovered.recover();
    await recovered.step(
      library,
      async () => {},
      open,
      () => false,
    );
    assert.equal(calls, 1);
    assert.equal(recovered.get('job')?.state, 'completed');
  } finally {
    s.db.close();
  }
});

test('a restart after the paid-call boundary reports unknown failure without reissuing', async () => {
  const s = fixture();
  let calls = 0;
  try {
    s.jobs.enqueue('chat', 'unknown', config, 'q', 'a');
    await s.jobs.step(
      s.library,
      async () => {
        throw Error('uncertain output gate');
      },
      async () => {
        calls++;
        return body();
      },
      () => false,
    );
    assert.equal(s.jobs.get('unknown')?.state, 'delivering');
    const recovered = new ConversationTitles(
      s.query,
      () => true,
      () => 100_000,
    );
    recovered.recover();
    await recovered.step(
      s.library,
      async () => {},
      async () => {
        calls++;
        return body();
      },
      () => false,
    );
    assert.equal(calls, 0);
    assert.equal(recovered.get('unknown')?.state, 'failed');
    assert.match(recovered.get('unknown')?.error ?? '', /重复计费/);
    assert.equal(
      s.query<{ title: string }>('SELECT title FROM conversations').one().title,
      'fallback',
    );
  } finally {
    s.db.close();
  }
});

test('manual rename before reservation or after a model starts protects the latest title', async () => {
  const s = fixture();
  try {
    s.jobs.enqueue('chat', 'before', config, 'q', 'a', false, 1);
    s.titles.manual('chat');
    await s.jobs.step(
      s.library,
      async () => {},
      async () => {
        throw Error('must not call');
      },
      () => false,
    );
    assert.equal(s.jobs.get('before')?.state, 'superseded');
    s.jobs.enqueue('chat', 'during', config, 'q', 'a', false, 2);
    await s.jobs.step(
      s.library,
      async () => {},
      async () => {
        s.titles.manual('chat');
        s.query("UPDATE conversations SET title='user choice'");
        return body();
      },
      () => false,
    );
    assert.equal(s.jobs.get('during')?.state, 'superseded');
    assert.equal(
      s.query<{ title: string }>('SELECT title FROM conversations').one().title,
      'user choice',
    );
    assert.ok('rejected' in s.titles.reserve('chat', 'automatic', true));
  } finally {
    s.db.close();
  }
});

test('supplier failure keeps the existing title and permits a fresh explicit retry', async () => {
  const s = fixture();
  let calls = 0;
  try {
    s.jobs.enqueue('chat', 'failure', config, 'q', 'a');
    await s.jobs.step(
      s.library,
      async () => {},
      async () => {
        calls++;
        throw Error('secret upstream');
      },
      () => false,
    );
    assert.equal(s.jobs.get('failure')?.state, 'failed');
    assert.doesNotMatch(s.jobs.get('failure')?.error ?? '', /secret/);
    assert.equal(s.jobs.nextAlarm(), null);
    s.jobs.enqueue('chat', 'retry', config, 'q', 'a');
    await s.jobs.step(
      s.library,
      async () => {},
      async () => {
        calls++;
        return body();
      },
      () => false,
    );
    assert.equal(calls, 2);
    assert.equal(s.jobs.get('retry')?.state, 'completed');
  } finally {
    s.db.close();
  }
});

test('deletion during a supplier request cannot recreate erased task tables', async () => {
  const s = fixture();
  try {
    s.jobs.enqueue('chat', 'delete', config, 'q', 'a');
    await s.jobs.step(
      s.library,
      async () => {},
      async () => {
        s.kill();
        s.db.exec('DROP TABLE title_jobs;DROP TABLE title_automatic');
        return body();
      },
      () => false,
    );
    assert.equal(
      s.query("SELECT name FROM sqlite_master WHERE name='title_jobs'").toArray().length,
      0,
    );
  } finally {
    s.db.close();
  }
});

test('model title output becomes one nonempty plain line without splitting emoji', () => {
  assert.equal(cleanTitle('```text\n# “标题”\n第二行\n```'), '标题');
  assert.equal(cleanTitle('<b>标题</b>'), '标题');
  assert.equal(cleanTitle('😀'.repeat(100)).length, 80);
  assert.throws(() => cleanTitle('```\n\n```'));
});
