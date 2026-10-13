import type { GenerationMeasurements, StreamCounts } from '../shared/generation-metrics';
import type { GenerationExecutor, MessageStatus } from '../shared/types';

export class GenerationMeter {
  private readonly startedAt: number;
  private readonly encoder = new TextEncoder();
  private counts = {
    textDeltas: 0, reasoningDeltas: 0, checkpoints: 0, checkpointCharacters: 0,
    sqlStatements: 0, sqlRowsRead: 0, sqlRowsWritten: 0, eventPayloadBytes: 0,
    broadcastFrames: 0, broadcastBytes: 0,
  };
  constructor(readonly runId: string, private readonly now: () => number = Date.now,
    private readonly coverage: GenerationMeasurements['coverage'] = 'claim-to-terminal', private readonly executor?: GenerationExecutor) { this.startedAt = now(); }
  checkpoint(contentLength: number, reasoningLength: number, upstream?: StreamCounts) {
    this.counts.checkpoints++;
    this.counts.checkpointCharacters += contentLength + reasoningLength;
    if (upstream) { this.counts.textDeltas = upstream.textDeltas; this.counts.reasoningDeltas = upstream.reasoningDeltas; }
  }
  sql(read: number, written: number) {
    this.counts.sqlStatements++;
    this.counts.sqlRowsRead += read;
    this.counts.sqlRowsWritten += written;
  }
  event(payload: string) { this.counts.eventPayloadBytes += this.encoder.encode(payload).byteLength; }
  broadcast(payload: string, recipients: number) {
    this.counts.broadcastFrames += recipients;
    if (recipients) this.counts.broadcastBytes += this.encoder.encode(payload).byteLength * recipients;
  }
  report(status: MessageStatus, databaseBytes: number, contentCharacters: number, reasoningCharacters: number): GenerationMeasurements {
    return { runId: this.runId, ...(this.executor ? { executor: this.executor } : {}), coverage: this.coverage, status, elapsedMs: Math.max(0, this.now() - this.startedAt), ...this.counts,
      databaseBytes, contentCharacters, reasoningCharacters };
  }
}

export type QueryResult<T extends Record<string, SqlStorageValue>> = Pick<SqlStorageCursor<T>, 'toArray' | 'one' | typeof Symbol.iterator>;
export type SqlQuery = <T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(statement: string, ...bindings: SqlStorageValue[]) => QueryResult<T>;

export function measuredQuery<T extends Record<string, SqlStorageValue>>(
  sql: SqlStorage, meter: GenerationMeter | undefined, statement: string, ...bindings: SqlStorageValue[]
): QueryResult<T> {
  const cursor = sql.exec<T>(statement, ...bindings);
  if (!meter) return cursor;
  // Row counters grow as the cursor is consumed; sampling exec() immediately undercounts reads.
  const rows = cursor.toArray();
  meter.sql(cursor.rowsRead, cursor.rowsWritten);
  let index = 0;
  return {
    toArray: () => { const remaining = rows.slice(index); index = rows.length; return remaining; },
    one: () => {
      if (rows.length - index !== 1) throw new Error('Expected exactly one SQL result');
      return rows[index++];
    },
    *[Symbol.iterator]() { while (index < rows.length) yield rows[index++]; },
  };
}
