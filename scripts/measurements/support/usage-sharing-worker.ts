// Isolated synthetic benchmark. This worker has no production bindings or AI upstream.
import { DurableObject } from 'cloudflare:workers';
import type { SqlQuery } from '../../../worker/generation/metrics';
import { UsageLedger } from '../../../worker/usage/store';
import { UsageOutbox } from '../../../worker/usage/outbox';
import { USAGE_SCHEMA, USAGE_OUTBOX_SCHEMA } from '../../../worker/usage/schema';
import { ShareRepository } from '../../../worker/sharing/store';
import { SHARING_SCHEMA } from '../../../worker/sharing/schema';
import { tokenHash, encryptToken } from '../../../worker/sharing/crypto';
import type { UsageAttempt } from '../../../shared/usage/types';

interface MeasurementEnv {
  MEASUREMENTS: DurableObjectNamespace<UsageSharingMeasurement>;
  MEASUREMENT_TOKEN: string;
  MEASUREMENT_RUN: string;
}
export class UsageSharingMeasurement extends DurableObject<MeasurementEnv> {
  private counts = { statements: 0, rowsRead: 0, rowsWritten: 0, outgoingRpc: 0 };
  private readonly query: SqlQuery = <T extends Record<string, SqlStorageValue>>(
    statement: string,
    ...args: SqlStorageValue[]
  ) => {
    const cursor = this.ctx.storage.sql.exec<T>(statement, ...args);
    const rows = cursor.toArray();
    this.counts.statements++;
    this.counts.rowsRead += cursor.rowsRead;
    this.counts.rowsWritten += cursor.rowsWritten;
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error('Expected one row');
        return rows[0];
      },
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
  };
  private ledger() {
    return new UsageLedger(this.query);
  }
  private shares() {
    return new ShareRepository(this.query);
  }
  initialize(kind: string) {
    this.ctx.storage.sql.exec(
      kind === 'ledger' ? USAGE_SCHEMA : kind === 'source' ? USAGE_OUTBOX_SCHEMA : SHARING_SCHEMA,
    );
    if (kind === 'ledger')
      this.ledger().savePrice({
        providerId: 'synthetic',
        model: 'synthetic',
        currency: 'CNY',
        input: '2',
        output: '8',
        cacheRead: '0.2',
        cacheWrite: null,
        perRequest: null,
        source: 'synthetic benchmark',
      });
    this.counts = { statements: 0, rowsRead: 0, rowsWritten: 0, outgoingRpc: 0 };
    return this.ctx.storage.sql.databaseSize;
  }
  price() {
    return this.ledger().price('synthetic', 'synthetic');
  }
  record(attempt: UsageAttempt) {
    this.ctx.storage.transactionSync(() => this.ledger().record(attempt));
  }
  async run(start: number, count: number) {
    const outbox = new UsageOutbox(this.query),
      ledger = this.env.MEASUREMENTS.getByName(`${this.env.MEASUREMENT_RUN}-ledger`);
    const publish = async (attempt: UsageAttempt) => {
      this.counts.outgoingRpc++;
      await ledger.record(attempt);
    };
    for (let index = start; index < start + count; index++) {
      this.counts.outgoingRpc++;
      const price = await ledger.price();
      this.ctx.storage.transactionSync(() =>
        outbox.begin(
          {
            id: `synthetic-${index}`,
            conversationId: 'synthetic',
            messageId: `answer-${index}`,
            taskId: `task-${index}`,
            kind: 'chat',
            answer: true,
            providerId: 'synthetic',
            providerName: 'Synthetic',
            protocol: 'openai-chat',
            model: 'synthetic',
            modelName: 'Synthetic',
            startedAt: Date.UTC(2026, 9, 19) + index * 60_000,
          },
          price,
        ),
      );
      await outbox.flush(publish);
      this.ctx.storage.transactionSync(() =>
        outbox.finish(`synthetic-${index}`, {
          status: 'completed',
          usage: {
            inputTokens: 1000,
            cachedInputTokens: 300,
            outputTokens: 200,
            reasoningTokens: 50,
          },
          usageIsFinal: true,
          firstTokenMs: 500,
        }),
      );
      await outbox.flush(publish);
    }
  }
  async createShare() {
    const store = this.shares(),
      row = store.begin({
        operationId: this.env.MEASUREMENT_RUN,
        conversationId: 'synthetic',
        headId: 'synthetic',
        title: 'Synthetic snapshot',
        includeReasoning: false,
      });
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < 10; i++)
        store.append(row.id, i, {
          message: i,
          role: i % 2 ? 'assistant' : 'user',
          channel: 'text',
          text: '合成文本'.repeat(4096),
          omittedAttachments: 0,
        });
      store.finishDraft(row.id, 'synthetic', 10, 10, 0, 'synthetic');
    });
    const cipher = await encryptToken(
      this.env.MEASUREMENT_TOKEN,
      this.env.MEASUREMENT_TOKEN,
      row.id,
    );
    this.ctx.storage.transactionSync(() =>
      store.publish(
        row.id,
        'synthetic',
        'Synthetic snapshot',
        1,
        tokenHash(this.env.MEASUREMENT_TOKEN),
        cipher,
      ),
    );
    return row.id;
  }
  readShare(id: string, cursor: number) {
    const row = this.shares().authorize(id, this.env.MEASUREMENT_TOKEN);
    return Response.json(this.shares().page(row, cursor), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  closeShare(id: string) {
    this.shares().revoke(id);
    this.shares().cleanup();
  }
  metrics() {
    return { ...this.counts, allocatedBytes: this.ctx.storage.sql.databaseSize };
  }
  async clear() {
    await this.ctx.storage.deleteAll();
  }
}
export default {
  async fetch(request: Request, env: MeasurementEnv) {
    if (request.headers.get('Authorization') !== `Bearer ${env.MEASUREMENT_TOKEN}`)
      return new Response(null, { status: 404 });
    const url = new URL(request.url),
      mode = url.searchParams.get('mode');
    if (!['ledger', 'source', 'shares'].includes(mode ?? ''))
      return new Response(null, { status: 404 });
    const stub = env.MEASUREMENTS.getByName(`${env.MEASUREMENT_RUN}-${mode}`);
    if (url.pathname === '/initialize' && request.method === 'POST')
      return Response.json({ emptyBytes: await stub.initialize(mode!) });
    if (url.pathname === '/run' && request.method === 'POST' && mode === 'source') {
      const start = Number(url.searchParams.get('start')),
        count = Number(url.searchParams.get('count'));
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 10
      )
        return new Response(null, { status: 400 });
      await stub.run(start, count);
      return Response.json({ completed: count });
    }
    if (url.pathname === '/create' && request.method === 'POST' && mode === 'shares')
      return Response.json({ id: await stub.createShare() });
    if (url.pathname === '/read' && mode === 'shares')
      return stub.readShare(
        url.searchParams.get('id')!,
        Number(url.searchParams.get('cursor') ?? 0),
      );
    if (url.pathname === '/revoke' && request.method === 'POST' && mode === 'shares') {
      await stub.closeShare(url.searchParams.get('id')!);
      return Response.json({ revoked: true });
    }
    if (url.pathname === '/metrics') return Response.json(await stub.metrics());
    if (url.pathname === '/clear' && request.method === 'POST') {
      await stub.clear();
      return Response.json({ cleared: true });
    }
    return new Response(null, { status: 404 });
  },
};
