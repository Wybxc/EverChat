import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as v from 'valibot';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { InputReceipts, INPUT_RECEIPTS_SCHEMA } from '../../../worker/generation/input-receipts';
import { assembledInput, inputHash } from '../../../worker/providers/input-receipt';
import type { ProviderConfig } from '../../../shared/providers/types';
import { inputEvidenceBackupSchema } from '../../../shared/streaming/input-receipt';
import {
  SUMMARY_CONTEXT_PREFIX,
  SUMMARY_CONTEXT_SUFFIX,
} from '../../../shared/conversation/summaries';

const config: ProviderConfig = {
  provider: 'gemini',
  model: 'fixture',
  baseUrl: 'https://example.test',
  apiKey: 'secret-key',
  systemPrompt: 'private-preset',
  maxOutputTokens: null,
};
test('input receipts persist the actual selection, incremental steps and immutable source text without request bodies or system plaintext', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(INPUT_RECEIPTS_SCHEMA);
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
  try {
    const receipts = new InputReceipts(query);
    assert.equal(receipts.summary('old', false).state, 'unavailable');
    receipts.select('answer', {
      omitted: [
        {
          input: { role: 'user', content: 'old', source: { kind: 'message', messageId: 'old' } },
          reason: 'recent_messages',
        },
      ],
      summarized: ['covered'],
    });
    assert.equal(receipts.summary('answer', true).state, 'pending');
    const sourceText = 'a'.repeat(8191) + '🙂' + 'z'.repeat(8192);
    const summaryText = SUMMARY_CONTEXT_PREFIX + 'summary' + SUMMARY_CONTEXT_SUFFIX;
    const evidence = {
      ...assembledInput(config, [
        { role: 'user', content: sourceText, source: { kind: 'message', messageId: 'user' } },
        { role: 'user', content: summaryText, source: { kind: 'summary', messageId: 'summary' } },
      ]),
      requestSha256: inputHash('final wire body'),
      requestBytes: 15,
    };
    receipts.submit('step0', 'answer', 0, config, evidence);
    assert.equal(new InputReceipts(query).summary('answer', false).state, 'assembled');
    receipts.attempt('step0');
    assert.equal(receipts.summary('answer', false).state, 'submission_attempted');
    assert.throws(() => receipts.attempt('step0'), /repeated/);
    assert.throws(() => receipts.submit('step0', 'answer', 0, config, evidence), /replayed/);
    const page = receipts.page('answer', 0, 0)!;
    assert.ok('receipt' in page);
    if (!('receipt' in page)) throw new Error();
    assert.equal(page.receipt!.omittedMessages, 1);
    assert.equal(page.receipt!.summarizedMessages, 1);
    assert.equal(page.receipt!.estimatedInputTokens, null);
    assert.equal(page.items![0].content, 'redacted');
    const sources = new Map([
      ['user', sourceText],
      ['summary', 'summary'],
    ]);
    const source = (id: string, offset: number, limit: number) => {
      const value = sources.get(id);
      if (value === undefined) return null;
      let end = Math.min(value.length, offset + limit);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
      return { text: value.slice(offset, end), hasMore: end < value.length, nextOffset: end };
    };
    const first = receipts.text('answer', 0, 1, 0, source)!;
    assert.equal(first.text.length, 8191);
    const next = receipts.text('answer', 0, 1, first.nextOffset, source)!;
    assert.ok(next.text.startsWith('🙂'));
    assert.equal(receipts.text('answer', 0, 1, 8192, source)!.state, 'invalid_cursor');
    assert.equal(receipts.text('answer', 0, 2, 0, source)!.text, summaryText);
    assert.equal(receipts.text('answer', 0, 0, 0, source)!.state, 'redacted');
    sources.delete('user');
    assert.equal(receipts.text('answer', 0, 1, 0, source)!.state, 'content_unavailable');
    const toolText = '{"sources":[]}';
    receipts.submit('step1', 'answer', 1, config, {
      ...evidence,
      items: [
        ...evidence.items,
        {
          item: {
            kind: 'tool',
            role: 'tool',
            sourceId: null,
            sha256: inputHash(toolText),
            characters: toolText.length,
            bytes: toolText.length,
            scope: 'public_projection',
            content: 'snapshot',
          },
          snapshot: toolText,
        },
      ],
    });
    const second = receipts.page('answer', 1, 0)!;
    assert.ok('receipt' in second);
    if (!('receipt' in second)) throw new Error();
    assert.equal(second.receipt!.previousStepId, 'step0');
    assert.equal(
      second.items!.length,
      1,
      'base inputs are referenced, not copied for each tool step',
    );
    const backup = v.parse(inputEvidenceBackupSchema, receipts.export('answer'));
    assert.doesNotMatch(JSON.stringify(backup), /secret-key|private-preset|final wire body/);
    receipts.restore(
      'copy',
      backup,
      new Map([
        ['user', 'copied-user'],
        ['summary', 'copied-summary'],
      ]),
    );
    assert.equal(receipts.latest('copy')?.originStepId, 'step1');
    assert.equal(receipts.page('copy', 0, 0)?.items?.[1].sourceId, 'copied-user');
    const changes = query<{ n: number }>('SELECT total_changes() AS n').one().n;
    for (let i = 0; i < 3; i++) {
      receipts.summary('copy', false);
      receipts.page('copy', 0, 0);
      receipts.exclusions('copy', 0);
    }
    assert.equal(
      query<{ n: number }>('SELECT total_changes() AS n').one().n,
      changes,
      'reads never write',
    );
    receipts.erase('answer');
    assert.equal(receipts.latest('answer'), null);
    assert.ok(receipts.latest('copy'));
    const permitted = { ...config, receiptSystemPrompt: true };
    const assembled = assembledInput(permitted, []);
    const largeMetadata = {
      ranges: Array.from({ length: 1000 }, (_, i) => ({ start: i * 4, end: i * 4 + 2 })),
      name: '稿😀.typ',
    };
    assembled.items.push({
      item: {
        kind: 'document',
        role: 'user',
        sourceId: null,
        sha256: inputHash('text'),
        characters: 4,
        bytes: 4,
        content: 'metadata_only',
        scope: 'logical_input',
        attachment: largeMetadata,
      },
    });
    receipts.select('permitted', { omitted: [], summarized: [] });
    receipts.submit('permitted-step', 'permitted', 0, permitted, {
      ...assembled,
      requestSha256: inputHash('wire'),
      requestBytes: 4,
    });
    assert.equal(receipts.text('permitted', 0, 0, 0, () => null)!.state, 'redacted');
    assert.equal(receipts.text('permitted', 0, 0, 0, () => null, true)!.text, config.systemPrompt);
    const brief = receipts.page('permitted', 0, 0)!;
    assert.equal(brief.items![1].details, 'metadata_view');
    assert.ok(Buffer.byteLength(JSON.stringify(brief)) < 24 * 1024);
    let metadata = '',
      at = 0;
    for (;;) {
      const page = receipts.metadata('permitted', 0, 1, at)!;
      metadata += page.text;
      at = page.nextOffset;
      if (!page.hasMore) break;
    }
    assert.deepEqual(JSON.parse(metadata).attachment, largeMetadata);
  } finally {
    db.close();
  }
});
