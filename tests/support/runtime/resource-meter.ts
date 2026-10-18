// Isolated fixture instrumentation only. It observes native cursor counters without
// draining results early and never retains SQL, bindings, model text or secrets.
import type { ToolResourceWindow } from '../../../scripts/measurements/support/resources';
const emptySql = () => ({ statements: 0, rowsRead: 0, rowsWritten: 0 });
const emptyStream = () => ({ commits: 0, wireBytes: 0, payloadBytes: 0 });
const bucket = (statement: string) =>
  /\btool_stream_commits\b/i.test(statement)
    ? 'privateStream'
    : /\b(?:stream_commits|generation_checkpoints|message_content_chunks)\b/i.test(statement)
      ? 'publicStream'
      : /\bevents\b/i.test(statement)
        ? 'events'
        : /\b(?:web_tool_service|web_tool_requests)\b/i.test(statement)
          ? 'webService'
          : /\b(?:web_tool_\w+|tool_workflows|tool_model_permits)\b/i.test(statement)
            ? 'toolState'
            : /\bsearch_\w+\b/i.test(statement)
              ? 'search'
              : 'other';
type SqlBucket = ReturnType<typeof bucket>;
export class FixtureResourceMeter {
  readonly instanceId = crypto.randomUUID();
  private checkpointOffsets = new Map<string, number>();
  private windowId?: string;
  private startedAt = 0;
  private encoder = new TextEncoder();
  private counts = this.empty();
  private empty() {
    return {
      sql: Object.fromEntries(
        [
          'privateStream',
          'publicStream',
          'events',
          'webService',
          'toolState',
          'search',
          'other',
        ].map((name) => [name, emptySql()]),
      ) as Record<SqlBucket, ReturnType<typeof emptySql>>,
      streams: { public: emptyStream(), private: emptyStream() },
      eventPayloadBytes: 0,
      broadcasts: { frames: 0, bytes: 0 },
      alarms: { set: 0, delete: 0 },
      upstream: { modelRequests: 0, modelBytes: 0, toolRequests: 0, toolResponseBytes: 0 },
    };
  }
  begin(windowId: string) {
    this.windowId = windowId;
    this.startedAt = Date.now();
    this.counts = this.empty();
    return this.read();
  }
  read(): ToolResourceWindow | null {
    return this.windowId
      ? {
          windowId: this.windowId,
          instanceId: this.instanceId,
          elapsedMs: Date.now() - this.startedAt,
          ...structuredClone(this.counts),
        }
      : null;
  }
  upstream(kind: 'modelRequests' | 'modelBytes' | 'toolRequests' | 'toolResponseBytes', count = 1) {
    if (this.windowId) this.counts.upstream[kind] += count;
  }
  wrapState(ctx: DurableObjectState): DurableObjectState {
    const getWebSockets = ctx.getWebSockets?.bind(ctx);
    const sql = new Proxy(ctx.storage.sql, {
      get: (target, property) => {
        if (property !== 'exec') return this.bound(target, property);
        return <T extends Record<string, SqlStorageValue>>(
          statement: string,
          ...bindings: SqlStorageValue[]
        ) => {
          const cursor = target.exec<T>(statement, ...bindings);
          const checkpoint = /^\s*INSERT INTO generation_checkpoints\b/i.test(statement);
          const previousOffset = checkpoint
            ? (this.checkpointOffsets.get(String(bindings[0])) ?? 0)
            : 0;
          if (checkpoint) this.checkpointOffsets.set(String(bindings[0]), Number(bindings[3]));
          if (/^\s*DELETE FROM generation_checkpoints WHERE runId/i.test(statement))
            this.checkpointOffsets.delete(String(bindings[0]));
          if (!this.windowId || /\b(?:fixture_\w+|generation_measurements)\b/i.test(statement))
            return cursor;
          // Keep the original bucket when a cursor is consumed after another window begins.
          const counters = this.counts.sql[bucket(statement)];
          counters.statements++;
          let read = 0,
            written = 0;
          const sample = () => {
            counters.rowsRead += cursor.rowsRead - read;
            counters.rowsWritten += cursor.rowsWritten - written;
            read = cursor.rowsRead;
            written = cursor.rowsWritten;
          };
          sample();
          if (/^\s*INSERT INTO (?:tool_)?stream_commits\b/i.test(statement)) {
            const stream =
              this.counts.streams[
                /\btool_stream_commits\b/i.test(statement) ? 'private' : 'public'
              ];
            stream.commits++;
            stream.wireBytes += Number(bindings[4]) - Number(bindings[3]);
            stream.payloadBytes += this.encoder.encode(String(bindings[5])).byteLength;
          }
          if (checkpoint) {
            this.counts.streams.public.commits++;
            this.counts.streams.public.wireBytes += Math.max(
              0,
              Number(bindings[3]) - previousOffset,
            );
            this.counts.streams.public.payloadBytes += this.encoder.encode(
              String(bindings[4]),
            ).byteLength;
          }
          if (/^\s*INSERT INTO message_content_chunks\b/i.test(statement))
            this.counts.streams.public.payloadBytes += this.encoder.encode(
              String(bindings[3]),
            ).byteLength;
          if (/^\s*INSERT INTO events\b/i.test(statement))
            this.counts.eventPayloadBytes += this.encoder.encode(String(bindings[0])).byteLength;
          return new Proxy(cursor, {
            get: (target, property) => {
              if (property === Symbol.iterator)
                return function* () {
                  try {
                    for (const row of target) {
                      sample();
                      yield row;
                    }
                  } finally {
                    sample();
                  }
                };
              const value = Reflect.get(target, property, target);
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                try {
                  return value.apply(target, args);
                } finally {
                  sample();
                }
              };
            },
          });
        };
      },
    });
    const storage = new Proxy(ctx.storage, {
      get: (target, property) => {
        if (property === 'sql') return sql;
        if (property === 'setAlarm' || property === 'deleteAlarm')
          return (...args: unknown[]) => {
            if (this.windowId) this.counts.alarms[property === 'setAlarm' ? 'set' : 'delete']++;
            return (Reflect.get(target, property, target) as (...args: unknown[]) => unknown).apply(
              target,
              args,
            );
          };
        return this.bound(target, property);
      },
    });
    const observed = new Proxy(ctx, {
      get: (target, property) => {
        if (property === 'storage') return storage;
        if (property === 'getWebSockets')
          return (...args: Parameters<DurableObjectState['getWebSockets']>) =>
            getWebSockets(...args).map(
              (socket) =>
                new Proxy(socket, {
                  get: (target, property) => {
                    if (property !== 'send') return this.bound(target, property);
                    return (data: string | ArrayBuffer | ArrayBufferView) => {
                      target.send(data);
                      if (this.windowId) {
                        this.counts.broadcasts.frames++;
                        this.counts.broadcasts.bytes +=
                          typeof data === 'string'
                            ? this.encoder.encode(data).byteLength
                            : data.byteLength;
                      }
                    };
                  },
                }),
            );
        return this.bound(target, property);
      },
    });
    // DurableObjectBase requires the native state, rather than a Proxy, as its
    // constructor argument. Shadow just these JS accessors, preserving its brand.
    Object.defineProperties(ctx, {
      storage: { value: storage, configurable: true },
      getWebSockets: { value: observed.getWebSockets, configurable: true },
    });
    return ctx;
  }
  private bound(target: object, property: PropertyKey) {
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }
}
export type FixtureResourceReport = NonNullable<ReturnType<FixtureResourceMeter['read']>>;
