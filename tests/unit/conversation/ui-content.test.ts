import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { EverChatUIPart } from '../../../shared/conversation/ui-message';
import { toolUIPart } from '../../../shared/conversation/ui-message';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { UI_CONTENT_SCHEMA, UIContent } from '../../../worker/conversation/ui-content';
import { UIMessageState } from '../../../worker/streaming/ui-message-state';
import { validatePublicUIMessage } from '../../../shared/conversation/ui-validation';
import type { UIActiveBlock } from '../../../shared/streaming/ui-checkpoint';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...args: SqlStorageValue[]
  ) => {
    const rows = db
      .prepare(sql)
      .all(...(args as (string | number | null)[]))
      .map((row) => ({ ...row })) as T[];
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
  for (const sql of UI_CONTENT_SCHEMA) query(sql);
  db.exec(`CREATE TABLE text_writes(partIndex INTEGER,ordinal INTEGER);
    CREATE TRIGGER text_insert AFTER INSERT ON message_text_chunks BEGIN
      INSERT INTO text_writes VALUES (new.partIndex,new.ordinal); END;
    CREATE TRIGGER text_update AFTER UPDATE ON message_text_chunks BEGIN
      INSERT INTO text_writes VALUES (new.partIndex,new.ordinal); END;
    CREATE TRIGGER text_delete AFTER DELETE ON message_text_chunks BEGIN
      INSERT INTO text_writes VALUES (old.partIndex,old.ordinal); END;`);
  return { db, query, content: new UIContent(query) };
}
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('ordered content stores text once and reloads tools and reasoning in the same positions', () => {
  const f = fixture();
  try {
    const parts: EverChatUIPart[] = [
      { type: 'step-start' },
      { type: 'reasoning', id: 'first', text: '第一段思考'.repeat(3000), state: 'done' },
      toolUIPart({
        round: 0,
        call: { id: 's', name: 'web_search', input: { query: '搜索' } },
        state: 'completed',
        result: { id: 's', name: 'web_search', status: 'completed', sources: [] },
      }),
      { type: 'step-start' },
      { type: 'reasoning', id: 'second', text: '第二段思考', state: 'done' },
      { type: 'text', text: '正文🙂'.repeat(5000), state: 'streaming' },
    ];
    f.content.write('message', [], parts);
    assert.deepEqual(f.content.read('message'), stored(parts));
    const descriptors = f.query<{ payload: string }>('SELECT payload FROM message_parts').toArray();
    for (const { payload } of descriptors) assert.equal('text' in JSON.parse(payload), false);
    const total = f
      .query<{ total: number }>('SELECT SUM(textLength) AS total FROM message_parts')
      .one().total;
    assert.equal(
      total,
      parts
        .filter((part) => 'text' in part)
        .reduce((sum, part) => sum + ('text' in part ? part.text.length : 0), 0),
    );
    assert.equal(
      f
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('events','stream_commits','messages')",
        )
        .toArray().length,
      0,
    );
    f.content.erase('message');
    assert.deepEqual(f.content.read('message'), []);
    assert.equal(f.query('SELECT * FROM message_text_chunks').toArray().length, 0);
  } finally {
    f.db.close();
  }
});

test('an appended answer does not rewrite earlier text chunks and a tool update does not write text', () => {
  const f = fixture();
  try {
    const queued = {
      round: 0,
      state: 'queued' as const,
      call: { id: 's', name: 'web_search' as const, input: { query: 'q' } },
    };
    const parts: EverChatUIPart[] = [
      { type: 'reasoning', id: 'r', text: '思考', state: 'done' },
      toolUIPart(queued),
      { type: 'text', text: 'x'.repeat(8192), state: 'streaming' },
    ];
    f.content.write('message', [], parts);
    f.db.exec('DELETE FROM text_writes');
    const next: EverChatUIPart[] = [
      ...parts.slice(0, 2),
      { type: 'text', text: 'x'.repeat(8192) + '后续🙂', state: 'done' },
    ];
    f.content.write('message', parts, next);
    assert.deepEqual(f.query('SELECT * FROM text_writes').toArray(), [
      { partIndex: 2, ordinal: 2 },
    ]);
    f.db.exec('DELETE FROM text_writes');
    const finished = [...next];
    finished[1] = toolUIPart({
      ...queued,
      state: 'completed',
      result: { id: 's', name: 'web_search', status: 'completed', sources: [] },
    });
    f.content.write('message', next, finished);
    assert.deepEqual(f.query('SELECT * FROM text_writes').toArray(), []);
    assert.deepEqual(f.content.read('message'), stored(finished));
    f.content.write('message', finished, finished);
    assert.deepEqual(f.query('SELECT * FROM text_writes').toArray(), []);
  } finally {
    f.db.close();
  }
});

test('rollback and step replacement preserve the durable prefix without leaving obsolete text', () => {
  const f = fixture();
  try {
    const parts: EverChatUIPart[] = [
      { type: 'reasoning', id: 'r', text: '稳定前缀', state: 'done' },
      { type: 'step-start' },
      { type: 'text', text: 'x'.repeat(15000), state: 'streaming' },
    ];
    f.content.write('message', [], parts);
    const replacement: EverChatUIPart[] = [
      parts[0],
      { type: 'text', text: '替换后的正文', state: 'done' },
    ];
    f.db.exec('BEGIN');
    f.content.write('message', parts, replacement);
    f.db.exec('ROLLBACK');
    assert.deepEqual(f.content.read('message'), parts);
    f.content.write('message', parts, replacement);
    assert.deepEqual(f.content.read('message'), replacement);
    assert.deepEqual(
      f.query('SELECT partIndex,ordinal FROM message_text_chunks ORDER BY partIndex').toArray(),
      [
        { partIndex: 0, ordinal: 0 },
        { partIndex: 1, ordinal: 0 },
      ],
    );
    const shrink: EverChatUIPart[] = [{ type: 'text', text: '短正文', state: 'done' }];
    f.content.write('message', replacement, shrink);
    assert.deepEqual(f.content.read('message'), shrink);
  } finally {
    f.db.close();
  }
});

test('paged channel reads cross part and chunk boundaries without splitting surrogate pairs or including tool text', () => {
  const f = fixture();
  try {
    const parts: EverChatUIPart[] = [
      { type: 'text', text: 'a'.repeat(4095) + '🙂' },
      { type: 'reasoning', id: 'r', text: '思考🙂'.repeat(2500) },
      toolUIPart({
        round: 0,
        state: 'failed',
        call: {
          id: 'bad',
          name: 'unknown',
          input: '工具输入不应成为正文',
          invalid: true,
          error: '参数错误',
        },
        result: { id: 'bad', name: 'unknown', status: 'failed', error: '参数错误' },
      }),
      { type: 'text', text: '🙂结尾'.repeat(2200) },
    ];
    f.content.write('message', [], parts);
    for (const channel of ['text', 'reasoning'] as const) {
      for (const limit of [2, 17, 4096, 8192]) {
        let offset = 0,
          text = '',
          hasMore = true;
        while (hasMore) {
          const page = f.content.page('message', channel, offset, limit);
          assert.ok(page.nextOffset > offset);
          assert.equal(/[\uD800-\uDBFF]$/.test(page.text), false);
          assert.equal(/^[\uDC00-\uDFFF]/.test(page.text), false);
          text += page.text;
          offset = page.nextOffset;
          hasMore = page.hasMore;
        }
        assert.equal(
          text,
          parts
            .filter((part) => part.type === channel)
            .map((part) => ('text' in part ? part.text : ''))
            .join(''),
        );
      }
    }
    assert.deepEqual(f.content.page('missing', 'text', 0), {
      text: '',
      hasMore: false,
      nextOffset: 0,
    });
  } finally {
    f.db.close();
  }
});

test('missing or orphan text is reported as corruption instead of silently truncating a saved answer', () => {
  for (const mutate of [
    (db: DatabaseSync) => db.exec('DELETE FROM message_text_chunks WHERE ordinal=1'),
    (db: DatabaseSync) => db.exec('DELETE FROM message_parts'),
  ]) {
    const f = fixture();
    try {
      f.content.write('message', [], [{ type: 'text', text: 'x'.repeat(10000) }]);
      mutate(f.db);
      assert.throws(() => f.content.read('message'), /chunk|length/);
      if (f.query('SELECT * FROM message_parts').toArray().length)
        assert.throws(() => f.content.page('message', 'text', 0), /chunk|length/);
    } finally {
      f.db.close();
    }
  }
});

test('SQLite canonical parts and active IDs restore SDK state after a failed transaction without duplicating prefixes', async () => {
  const f = fixture();
  let state = new UIMessageState('answer');
  try {
    f.db.exec('CREATE TABLE active_checkpoint(messageId TEXT PRIMARY KEY,payload TEXT)');
    const prefix = '🙂正文'.repeat(4000);
    await state.apply([
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: '思考前缀' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: prefix },
    ]);
    const saved = state.checkpoint();
    const message = await validatePublicUIMessage(saved.message);
    f.db.exec('BEGIN');
    f.content.write('answer', [], message.parts);
    f.query('INSERT INTO active_checkpoint VALUES (?,?)', 'answer', JSON.stringify(saved.active));
    f.db.exec('COMMIT');
    await state.apply([{ type: 'text-delta', id: 't', delta: '失败的尾部' }]);
    const advanced = await validatePublicUIMessage(state.checkpoint().message);
    f.db.exec('BEGIN');
    f.content.write('answer', message.parts, advanced.parts);
    f.db.exec('ROLLBACK');
    await state.dispose();
    const active = JSON.parse(
      f.query<{ payload: string }>('SELECT payload FROM active_checkpoint').one().payload,
    ) as UIActiveBlock[];
    assert.equal(
      f
        .query<{ payload: string }>('SELECT payload FROM active_checkpoint')
        .one()
        .payload.includes(prefix),
      false,
    );
    state = await UIMessageState.restore({
      message: { id: 'answer', role: 'assistant', parts: f.content.read('answer') },
      active,
    });
    await state.apply([
      { type: 'reasoning-delta', id: 'r', delta: '，思考结束' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-delta', id: 't', delta: '，回答完成' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const complete = await validatePublicUIMessage(state.checkpoint().message);
    f.content.write('answer', message.parts, complete.parts);
    const reloaded = f.content.read('answer');
    assert.deepEqual(reloaded, stored(complete.parts));
    assert.equal(reloaded[1].type === 'reasoning' && reloaded[1].text, '思考前缀，思考结束');
    assert.equal(reloaded[2].type === 'text' && reloaded[2].text, prefix + '，回答完成');
    assert.deepEqual(state.checkpoint().active, []);
  } finally {
    await state.dispose();
    f.db.close();
  }
});
