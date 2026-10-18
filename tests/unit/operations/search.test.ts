import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { rebuildSearch } from '../../../scripts/operations/rebuild-search';
import { localSnapshot, restoreSnapshot } from '../../../scripts/operations/storage-snapshot';
import { decodeValue } from '../../../scripts/operations/storage-protocol';
import { initializeConversation } from '../../../worker/conversation/schema';
import { SearchIndex } from '../../../worker/search/index';

const storage = (db: DatabaseSync) =>
  ({
    sql: {
      exec(sql: string, ...args: (string | number | null)[]) {
        const rows = db.prepare(sql).all(...args);
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
      databaseSize: 0,
    },
    transactionSync<T>(fn: () => T) {
      return fn();
    },
  }) as unknown as DurableObjectStorage;

function fixture() {
  const library = new DatabaseSync(':memory:'),
    conversation = new DatabaseSync(':memory:');
  library.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,title TEXT NOT NULL);
    INSERT INTO conversations VALUES ('c','对话'),('deleted','删除的对话'),('copy','未完成的复制'),('import','未完成的导入');
    CREATE TABLE conversation_deletions(id TEXT PRIMARY KEY);
    INSERT INTO conversation_deletions VALUES ('deleted');
    CREATE TABLE conversation_copies(id TEXT PRIMARY KEY,status TEXT);
    INSERT INTO conversation_copies VALUES ('copy','pending');
    CREATE TABLE archive_imports(id TEXT PRIMARY KEY,status TEXT);
    INSERT INTO archive_imports VALUES ('import','pending');`);
  const index = new SearchIndex(storage(library));
  index.replace('c', [
    { messageId: 'stale', version: 100, role: 'assistant', content: 'obsolete', reasoning: '' },
  ]);
  library.exec(
    "INSERT INTO search_backfill(conversationId) VALUES ('c'); INSERT INTO search_problems VALUES ('c','old error')",
  );
  initializeConversation(storage(conversation).sql, false);
  conversation.exec(`INSERT INTO messages(id,role,content,status,createdAt,parentId) VALUES
    ('u','user','用户原文 **保留**','completed',1,NULL),
    ('a','assistant','fallback','completed',2,'u'),
    ('branch','assistant','另一分支','completed',3,'u'),
    ('failed','assistant','失败前已保存正文','failed',4,'u'),
    ('running','assistant','尚未完成','running',5,'u'),
    ('deleted','assistant','已删除','completed',6,'u'),
    ('summary','assistant','内部摘要','completed',7,'u');
    INSERT INTO message_summaries VALUES ('summary','{}');
    INSERT INTO message_deletions VALUES ('deleted',8);
    INSERT INTO message_search_versions VALUES ('a',123);`);
  for (const [channel, ordinal, text] of [
    ['content', 0, '**中文'],
    ['content', 1, '结果**🙂'],
    ['reasoning', 0, '思考\n下一行'],
  ] as const)
    conversation
      .prepare('INSERT INTO message_content_chunks VALUES (?,?,?,?)')
      .run('a', channel, ordinal, JSON.stringify(text));
  return { library, conversation, index };
}

test('offline search rebuild prepares canonical branches, chunks and versions, clears historical jobs and replays into a separate database', () => {
  const f = fixture(),
    remote = new DatabaseSync(':memory:');
  try {
    const before = localSnapshot(f.library, 'library'),
      source = localSnapshot(f.conversation, 'conversation');
    restoreSnapshot(remote, before);
    const patch = rebuildSearch(f.library, [{ id: 'c', db: f.conversation }]);
    for (const { sql, args } of patch) remote.prepare(sql).run(...args.map(decodeValue));
    assert.deepEqual(localSnapshot(remote, 'library'), localSnapshot(f.library, 'library'));
    assert.deepEqual(localSnapshot(f.conversation, 'conversation'), source);
    for (const db of [f.library, remote]) {
      const index = new SearchIndex(storage(db));
      for (const q of ['中文结果🙂', '思考 下一行', '另一分支', '失败前', '用户原文 **保留**'])
        assert.equal(index.search(q).results.length, 1, q);
      for (const q of ['obsolete', 'fallback', '尚未完成', '已删除', '内部摘要'])
        assert.equal(index.search(q).results.length, 0, q);
      assert.equal(
        db.prepare("SELECT version FROM search_messages WHERE messageId='a'").get()!.version,
        123,
      );
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_backfill').get()!.n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_problems').get()!.n, 0);
    }
    // Rollback restores the external-content FTS index from backed-up fields,
    // without copying SQLite shadow tables or interpreting messages remotely.
    const rollback = new DatabaseSync(':memory:');
    try {
      restoreSnapshot(rollback, before);
      assert.equal(new SearchIndex(storage(rollback)).search('obsolete').results.length, 1);
    } finally {
      rollback.close();
    }
  } finally {
    f.library.close();
    f.conversation.close();
    remote.close();
  }
});

test('offline rebuild refuses an incomplete inventory and rolls back fields, FTS, versions and queue together', () => {
  const f = fixture();
  try {
    const before = localSnapshot(f.library, 'library');
    assert.throws(() => rebuildSearch(f.library, []), /Missing canonical/);
    assert.deepEqual(localSnapshot(f.library, 'library'), before);
    assert.equal(f.index.search('obsolete').results.length, 1);
    f.conversation.exec("UPDATE message_content_chunks SET payload='invalid'");
    assert.throws(() => rebuildSearch(f.library, [{ id: 'c', db: f.conversation }]));
    assert.deepEqual(localSnapshot(f.library, 'library'), before);
  } finally {
    f.library.close();
    f.conversation.close();
  }
});

test('the operations CLI converts conversations before rebuilding Library entirely offline and refuses changed resume options', async () => {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), 'everchat-offline-search-'));
  try {
    const objects = [
      { kind: 'library', id: '0'.repeat(64) },
      { kind: 'conversation', id: '1'.repeat(64), name: 'c' },
    ];
    const save = (name: string, value: unknown) =>
      writeFile(join(directory, name), JSON.stringify(value), { mode: 0o600 });
    await save('manifest.json', {
      runId: crypto.randomUUID(),
      account: 'offline',
      worker: 'offline',
      objects,
    });
    await save('backup-complete.json', { objects: 2 });
    for (const target of objects)
      await save(
        `${target.kind}-${target.id}.before.json`,
        localSnapshot(
          target.kind === 'library' ? f.library : f.conversation,
          target.kind as 'library' | 'conversation',
        ),
      );
    const run = (rebuild: boolean) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx/esm',
          'scripts/operations/storage.ts',
          'convert',
          ...(rebuild ? ['--rebuild-search'] : []),
          '--directory',
          directory,
        ],
        { encoding: 'utf8', timeout: 30000 },
      );
    const result = run(true);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"remoteRequests":0/);
    const file = join(directory, `library-${objects[0].id}.patch.json`);
    const patch = JSON.parse(await readFile(file, 'utf8')) as { statements: { sql: string }[] };
    assert.match(patch.statements.at(-1)!.sql, /INSERT INTO storage_schema/);
    assert.ok(patch.statements.some(({ sql }) => sql.includes('INSERT INTO search_fields')));
    assert.equal(run(true).status, 0);
    assert.notEqual(run(false).status, 0);
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(patch));
  } finally {
    f.library.close();
    f.conversation.close();
    await rm(directory, { recursive: true, force: true });
  }
});
