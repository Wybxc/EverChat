import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { createTestHarness } from 'wrangler';
import { migrateStorage } from '../../../scripts/operations/migrate-storage';
import type { Statement } from '../../../scripts/operations/storage-protocol';

test('native maintenance transport rejects anonymous HTTP, preserves unrelated state and atomically retries interrupted imports', async () => {
  const runId = crypto.randomUUID();
  const harness = createTestHarness({
    workers: [
      {
        config: {
          name: 'operations-client',
          main: resolve('tests/integration/operations/client-worker.ts'),
          compatibility_date: '2026-10-09',
          services: [
            { binding: 'OPERATIONS', service: 'operations-maintenance', entrypoint: 'Operations' },
          ],
        },
      },
      {
        config: {
          name: 'operations-maintenance',
          main: resolve('scripts/operations/maintenance-worker.ts'),
          compatibility_date: '2026-10-09',
          compatibility_flags: ['nodejs_compat'],
          vars: {
            OPS_RUN_ID: runId,
            OPS_ADMIN_EMAIL: 'operator@example.com',
            ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
            ACCESS_AUD: 'test-audience',
            ACCESS_ALLOWED_EMAILS: 'operator@example.com',
            APP_ORIGIN: 'https://everchat.invalid',
          },
          durable_objects: {
            bindings: [
              { name: 'CONVERSATIONS', class_name: 'Conversation' },
              { name: 'LIBRARY', class_name: 'Library' },
            ],
          },
          migrations: [{ tag: 'v1', new_sqlite_classes: ['Conversation', 'Library'] }],
        },
      },
    ],
  });
  const local = new DatabaseSync(':memory:');
  try {
    await harness.listen();
    const client = harness.getWorker('operations-client'),
      worker = harness.getWorker('operations-maintenance');
    assert.equal((await worker.fetch('https://everchat.invalid/identity')).status, 503);
    assert.equal(
      (await worker.fetch('https://everchat.invalid/api/__operations/identity')).status,
      401,
    );
    assert.deepEqual(await (await client.fetch('https://operations.invalid/identity')).json(), {
      runId,
    });
    const env = (await worker.getEnv()) as { LIBRARY: DurableObjectNamespace };
    const id = env.LIBRARY.idFromName('personal').toString();
    const remote = await worker.getDurableObjectStorage('LIBRARY', { id });
    const seed = [
      'CREATE TABLE conversation_metadata(id TEXT PRIMARY KEY,pinned INTEGER NOT NULL,archived INTEGER NOT NULL)',
      "INSERT INTO conversation_metadata VALUES ('preserved',1,1)",
      'CREATE TABLE web_tool_service(id INTEGER PRIMARY KEY,apiKey TEXT NOT NULL,dailyLimit INTEGER NOT NULL)',
      "INSERT INTO web_tool_service VALUES (1,'private-key',20)",
      'CREATE TABLE unrelated(id TEXT PRIMARY KEY,payload TEXT)',
      "INSERT INTO unrelated VALUES ('untouched','private-data')",
      'CREATE TABLE conversations(id TEXT PRIMARY KEY)',
      "INSERT INTO conversations VALUES ('live')",
      'CREATE TABLE conversation_deletions(id TEXT PRIMARY KEY)',
      "INSERT INTO conversation_deletions VALUES ('deleted')",
      'CREATE TABLE conversation_copies(id TEXT PRIMARY KEY,sourceId TEXT)',
      "INSERT INTO conversation_copies VALUES ('copy','live')",
    ];
    for (const sql of seed) {
      local.exec(sql);
      await remote.exec(sql);
    }
    const catalog = await (
      await client.fetch('https://operations.invalid/catalog?offset=0')
    ).json();
    const conversations = (await worker.getEnv()) as { CONVERSATIONS: DurableObjectNamespace };
    assert.deepEqual(
      catalog,
      ['copy', 'deleted', 'live'].map((name) => ({
        kind: 'conversation',
        id: conversations.CONVERSATIONS.idFromName(name).toString(),
      })),
    );
    assert.deepEqual(
      await (await client.fetch('https://operations.invalid/catalog?offset=3')).json(),
      [],
    );
    const request = async (action: string, more: Record<string, unknown> = {}) =>
      client.fetch('https://operations.invalid/', {
        method: 'POST',
        body: JSON.stringify({ runId, kind: 'library', id, action, ...more }),
      });
    const patch = migrateStorage(local, 'library');
    await assert.rejects(
      request('apply', { job: 'test-job', page: 1, statements: [patch[0]] }),
      /Patch page gap/,
    );
    const first = patch.slice(0, 2);
    assert.equal(
      (await request('apply', { job: 'test-job', page: 0, statements: first })).status,
      200,
    );
    assert.equal(
      (await request('apply', { job: 'test-job', page: 0, statements: first })).status,
      200,
    );
    await assert.rejects(
      request('apply', { job: 'test-job', page: 0, statements: [{ sql: 'SELECT 1', args: [] }] }),
      /Conflicting patch retry/,
    );
    const broken: Statement[] = [
      { sql: "INSERT INTO conversation_metadata VALUES ('rolled-back',0,0)", args: [] },
      { sql: 'INVALID SQL', args: [] },
    ];
    await assert.rejects(
      request('apply', { job: 'test-job', page: 1, statements: broken }),
      /syntax error/,
    );
    assert.deepEqual(
      await remote.exec("SELECT id FROM conversation_metadata WHERE id='rolled-back'"),
      [],
    );
    assert.deepEqual(await (await request('receipt')).json(), { job: 'test-job', page: 0 });
    for (let index = 2; index < patch.length; index++)
      assert.equal(
        (await request('apply', { job: 'test-job', page: index - 1, statements: [patch[index]] }))
          .status,
        200,
      );
    for (const table of [
      'conversation_metadata',
      'web_tool_service',
      'web_tool_credentials',
      'storage_schema',
    ]) {
      const rows = await (await request('rows', { table, offset: 0 })).json();
      assert.deepEqual(
        rows,
        local
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => ({ ...row })),
      );
    }
    assert.deepEqual(await remote.exec('SELECT * FROM unrelated'), [
      { id: 'untouched', payload: 'private-data' },
    ]);
    assert.equal((await request('cleanup')).status, 200);
    assert.deepEqual(await (await request('receipt')).json(), null);
  } finally {
    local.close();
    await harness.close();
  }
});
