import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { renderShareMessages } from '../../../worker/sharing/render';
import { shareDocument } from '../../../worker/sharing/document';
import { migrateShares } from '../../../scripts/operations/migrate-shares';
import type { ShareBlock } from '../../../shared/sharing/types';
const template =
  '<!doctype html><html lang="en"><title>__EVERCHAT_SHARE_TITLE__</title><div id="root" data-share-id="__EVERCHAT_SHARE_ID__" data-share-expiry="__EVERCHAT_SHARE_EXPIRY__"><!--EVERCHAT_SHARE--></div></html>';
const share = {
  id: 'a'.repeat(22),
  title: '<script>title</script>',
  createdAt: 1,
  expiresAt: null,
  messageCount: 2,
  omittedAttachments: 0,
  hash: 'hash',
};
const block = (text: string, channel: 'text' | 'reasoning' = 'text'): ShareBlock => ({
  message: 1,
  role: 'assistant',
  channel,
  text,
  modelName: '公开模型',
  omittedAttachments: 0,
});
test('initial HTML contains full Markdown and collapsed reasoning, preserves fences across transport chunks and never loads remote images', async () => {
  const blocks = [
    block('**thought**', 'reasoning'),
    block('before\nline\n\n|A|B|\n|-|-|\n|1|2|\n\n$$x^2$$\n\n```js\nconst a'),
    block(
      '=1;\n```\n\n<script>alert(1)</script>\n[bad](javascript:alert(1))\n![image](https://tracker.invalid/a.png)',
    ),
  ];
  const parts = [...renderShareMessages(blocks.map((b) => JSON.stringify(b)))];
  const response = shareDocument(
    template,
    'zh-CN',
    share,
    (function* () {
      yield* parts;
    })(),
  );
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN"/);
  assert.match(html, /&lt;script&gt;title/);
  assert.match(html, /<table/);
  assert.match(html, /class="katex/);
  assert.match(html, /const a=1;/);
  assert.match(html, /data-streamdown="strong">thought<\/span>/);
  assert.match(html, /<details[^>]*data-testid="share-reasoning"/);
  assert.doesNotMatch(
    html,
    /<details[^>]*\bopen\b|<script>|javascript:|<img|rel="preload" as="image"/,
  );
  assert.doesNotMatch(html, /__EVERCHAT_|EVERCHAT_MESSAGES|private-provider/);
});
test('rendered HTML is split into SQL sized UTF-8-safe rows, while cancelled documents stop reading', async () => {
  const parts = [...renderShareMessages([JSON.stringify(block('🙂'.repeat(30000)))])];
  assert.ok(parts.length >= 4);
  for (const part of parts) {
    assert.ok(part.length <= 16384);
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(part)), part);
  }
  let count = 0,
    closed = false;
  const response = shareDocument(
    template,
    'en',
    share,
    (function* () {
      try {
        for (let i = 0; i < 10000; i++) {
          count++;
          yield '<p>part</p>';
        }
      } finally {
        closed = true;
      }
    })(),
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  assert.ok(count < 3);
  assert.equal(closed, true);
});
test('offline sharing conversion preserves IDs and content, removes credentials and prepares only active snapshots', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE storage_schema(id INTEGER PRIMARY KEY,version INTEGER); INSERT INTO storage_schema VALUES(1,1);
    CREATE TABLE shares(id TEXT PRIMARY KEY,operationId TEXT UNIQUE NOT NULL,conversationId TEXT NOT NULL,headId TEXT NOT NULL,sourceVersion TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,draftUntil INTEGER NOT NULL,status TEXT NOT NULL,title TEXT NOT NULL,includeReasoning INTEGER NOT NULL,messageCount INTEGER NOT NULL,blockCount INTEGER NOT NULL,omittedAttachments INTEGER NOT NULL,hash TEXT NOT NULL,tokenHash TEXT,tokenCipher TEXT,expiresAt INTEGER);
    CREATE TABLE share_blocks(shareId TEXT NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(shareId,seq));CREATE TABLE share_deletions(conversationId TEXT PRIMARY KEY);`);
    const payload = JSON.stringify(block('**preserved**'));
    const hash = createHash('sha256')
      .update(payload + '\n')
      .digest('hex');
    for (const [id, status, expiresAt] of [
      ['active', 'active', null],
      ['draft', 'draft', null],
      ['expired', 'active', 1],
    ] as const) {
      db.prepare('INSERT INTO shares VALUES(?,?,?,?,?,1,1,10000,?,?,1,1,1,0,?,?,?,?)').run(
        id,
        id,
        'conversation',
        'head',
        'version',
        status,
        'title',
        hash,
        'secret hash',
        'cipher',
        expiresAt,
      );
      db.prepare('INSERT INTO share_blocks VALUES(?,0,?)').run(id, payload);
    }
    const patch = migrateShares(db, 1000);
    assert.equal(db.prepare('SELECT version FROM storage_schema').get()!.version, 2);
    assert.deepEqual(
      db
        .prepare('SELECT id FROM shares ORDER BY id')
        .all()
        .map((r) => r.id),
      ['active', 'draft', 'expired'],
    );
    assert.equal(db.prepare('SELECT COUNT(DISTINCT shareId) AS n FROM share_html').get()!.n, 1);
    assert.match(
      String(db.prepare('SELECT html FROM share_html').get()!.html),
      /data-streamdown="strong">preserved<\/span>/,
    );
    assert.doesNotMatch(
      JSON.stringify(db.prepare('PRAGMA table_info(shares)').all()),
      /tokenHash|tokenCipher/,
    );
    assert.equal(
      db.prepare('SELECT payload FROM share_blocks WHERE shareId=?').get('active')!.payload,
      payload,
    );
    assert.doesNotMatch(JSON.stringify(patch), /secret hash|cipher/);
  } finally {
    db.close();
  }
});
