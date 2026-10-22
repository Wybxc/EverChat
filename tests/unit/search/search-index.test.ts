import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { SearchDocument } from '../../../shared/search/query';
import { SearchChanged, SearchIndex, searchableMarkdown } from '../../../worker/search/index';

function fixture() {
  const db = new DatabaseSync(':memory:');
  let size = 0;
  const sql = {
    get databaseSize() {
      return size;
    },
    exec(statement: string, ...bindings: (string | number | null)[]) {
      const rows = db.prepare(statement).all(...bindings);
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
    },
  };
  const storage = {
    sql,
    transactionSync<T>(operation: () => T): T {
      db.exec('BEGIN');
      try {
        const result = operation();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  sql.exec('CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT)');
  sql.exec('CREATE TABLE conversation_metadata(id TEXT PRIMARY KEY, archived INTEGER)');
  sql.exec('CREATE TABLE conversation_deletions(id TEXT PRIMARY KEY)');
  sql.exec("INSERT INTO conversations VALUES ('c', '标题')");
  const index = new SearchIndex(storage);
  return {
    db,
    sql,
    index,
    fill: () => {
      size = 256 * 1024 * 1024 + 1;
    },
  };
}
const document = (
  messageId: string,
  content: string,
  version = 1,
  reasoning = '',
): SearchDocument => ({ messageId, content, version, reasoning, role: 'assistant' });

test('search indexes visible Markdown text across inline formatting and ignores link destinations', () => {
  assert.equal(
    searchableMarkdown(
      '跨越 **格式** 搜索。\n\n[文字](https://hidden.test)\n\n```js\nconst TARGET = 1;\n```',
    ),
    '跨越 格式 搜索。\n文字\nconst TARGET = 1;',
  );
  assert.equal(
    searchableMarkdown('跨越 ~~格式~~ 搜索。\n\n| A | B |\n| - | - |\n| 中文 | 正文 |'),
    '跨越 格式 搜索。\nA\nB\n中文\n正文',
  );
  const { db, index } = fixture();
  try {
    index.replace('c', [
      document('m', '跨越 **格式** 搜索。\n\n[文字](https://hidden.test)', 1, '思考 **中文** 😀'),
    ]);
    assert.equal(index.search('跨越 格式 搜索').results[0].messageId, 'm');
    assert.equal(index.search('hidden.test').results.length, 0);
    assert.equal(index.search('思考 中文').results[0].field, 'reasoning');
    for (const query of ['中', '中文', '😀']) assert.equal(index.search(query).results.length, 1);
  } finally {
    db.close();
  }
});
test('literal GLOB, punctuation, Unicode case and SQL syntax do not turn into operators', () => {
  const { db, index } = fixture();
  try {
    index.replace('c', [document('m', '[a+b] literal*mark question?mark percent%mark ÅBC 中文😀')]);
    for (const query of ['[a+b]', '*', '?', '%', 'åbc', '中文😀'])
      assert.equal(index.search(query).results.length, 1, query);
    assert.equal(index.search("' OR 1=1 --").results.length, 0);
  } finally {
    db.close();
  }
});
test('versions prevent duplicate writes and stale backfills; replacement and deletion clear FTS entries', () => {
  const { db, sql, index } = fixture();
  try {
    index.replace('c', [document('m', 'old body', 1, 'old thought')]);
    index.replace('c', [document('m', 'new body', 3)]);
    const revision = sql.exec('SELECT revision FROM search_revision').one().revision;
    index.replace('c', [document('m', 'stale body', 2), document('m', 'new body', 3)]);
    assert.equal(sql.exec('SELECT revision FROM search_revision').one().revision, revision);
    assert.equal(index.search('old').results.length, 0);
    assert.equal(index.search('stale').results.length, 0);
    assert.equal(index.search('new').results.length, 1);
    index.remove('c');
    assert.equal(index.search('new').results.length, 0);
    assert.equal(sql.exec('SELECT COUNT(*) AS count FROM search_messages').one().count, 0);
  } finally {
    db.close();
  }
});
test('keyset pagination covers all results, validates query/revision, and excludes deleted rows', () => {
  const { db, sql, index } = fixture();
  try {
    index.replace(
      'c',
      Array.from({ length: 47 }, (_, i) => document(`m${i}`, '分页 中文 QUERY')),
    );
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = index.search('分页 中文', cursor);
      assert.ok(page.results.length <= 20);
      ids.push(...page.results.map((item) => item.messageId));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    assert.equal(ids.length, 47);
    assert.equal(new Set(ids).size, 47);
    const first = index.search('query');
    assert.throws(() => index.search('different', first.cursor!), SearchChanged);
    index.replace('c', [document('extra', 'query')]);
    assert.throws(() => index.search('query', first.cursor!), SearchChanged);
    sql.exec("INSERT INTO conversation_metadata VALUES ('c', 1)");
    assert.equal(index.search('query').results.length, 20);
    sql.exec("INSERT INTO conversation_deletions VALUES ('c')");
    assert.equal(index.search('query').results.length, 0);
  } finally {
    db.close();
  }
});
test('index writes continue above the old Library size budget', () => {
  const { db, sql, index, fill } = fixture();
  try {
    index.replace('c', [document('m', 'retained body')]);
    fill();
    index.replace('c', [document('m', 'lost body', 2)]);
    assert.equal(index.search('retained').results.length, 0);
    assert.equal(index.search('lost').results.length, 1);
    assert.equal(sql.exec('SELECT version FROM search_messages').one().version, 2);
  } finally {
    db.close();
  }
});
