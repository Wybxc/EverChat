// Local workerd fixture only. Uses synthetic rows and never calls a model.
import type { Env } from '../../../worker/http/env';
import { Library } from '../../../worker/library/durable-object';
import { Conversation } from '../../../worker/conversation/durable-object';
import { FixtureResourceMeter } from '../../../tests/support/runtime/resource-meter';

// SQL templates are retained only inside this synthetic fixture, never bindings.
class StatementReads {
  private readonly reads = new Map<string, number>();
  wrap(ctx: DurableObjectState) {
    const sql = new Proxy(ctx.storage.sql, {
      get: (target, property) => {
        if (property !== 'exec') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (statement: string, ...bindings: SqlStorageValue[]) => {
          const cursor = target.exec(statement, ...bindings);
          let previous = 0;
          const sample = () => {
            this.reads.set(
              statement,
              (this.reads.get(statement) ?? 0) + cursor.rowsRead - previous,
            );
            previous = cursor.rowsRead;
          };
          sample();
          return new Proxy(cursor, {
            get: (target, property) => {
              if (property === Symbol.iterator)
                return function* () {
                  try {
                    yield* target;
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
      get(target, property) {
        if (property === 'sql') return sql;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    Object.defineProperty(ctx, 'storage', { value: storage, configurable: true });
    return ctx;
  }
  top() {
    return [...this.reads]
      .sort((a, b) => b[1] - a[1])
      .filter(([, rows]) => rows > 0)
      .slice(0, 6)
      .map(([statement, rowsRead]) => ({
        statement: statement.replace(/\s+/g, ' ').trim(),
        rowsRead,
      }));
  }
}

export class ReadLibrary extends Library {
  private readonly probe: FixtureResourceMeter;
  constructor(ctx: DurableObjectState, env: Env) {
    const probe = new FixtureResourceMeter();
    probe.begin('constructor');
    super(probe.wrapState(ctx), env);
    this.probe = probe;
  }
  counters() {
    return this.probe.read();
  }
  startWindow(name: string) {
    return this.probe.begin(name);
  }
  seed(count: number) {
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < count; i++) {
        const id = `synthetic-${i}`;
        this.ctx.storage.sql.exec(
          'INSERT INTO conversations VALUES (?, ?, 1, 1)',
          id,
          `Synthetic ${i}`,
        );
        this.ctx.storage.sql.exec('INSERT INTO conversation_metadata VALUES (?, 0)', id);
        this.ctx.storage.sql.exec(
          "INSERT INTO conversation_titles VALUES (?, 'manual', 1, NULL)",
          id,
        );
        this.ctx.storage.sql.exec(
          'INSERT INTO conversation_activity VALUES (?, 1, ?)',
          id,
          JSON.stringify({ status: 'idle', version: 1, updatedAt: 1 }),
        );
      }
    });
  }
  snapshots(count: number) {
    this.probe.begin('full-snapshot');
    let returned = 0;
    for (let i = 0; i < count; i++) returned = this.indexSnapshot(0).conversations.length;
    return { returned, calls: count, counters: this.probe.read() };
  }
  async controlHandshakes(count: number) {
    this.probe.begin('control-handshakes');
    for (let i = 0; i < count; i++) {
      const response = await this.fetch(
        new Request(
          `https://synthetic.invalid/api/notifications/sync?instance=${crypto.randomUUID()}`,
          {
            headers: {
              Upgrade: 'websocket',
              'X-Notification-Owner': 'synthetic-owner',
              'X-Session-Expires': String(Math.floor(Date.now() / 1000) + 3600),
            },
          },
        ),
      );
      if (response.status !== 101 || !response.webSocket) throw new Error('Control upgrade failed');
      response.webSocket.accept();
      response.webSocket.close(1000);
    }
    return this.probe.read();
  }
  accessChecks(count: number) {
    this.probe.begin('conversation-access');
    for (let i = 0; i < count; i++) this.get('synthetic-0');
    return this.probe.read();
  }
  prepareCandidates() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE sync_probe_revision(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec('INSERT INTO sync_probe_revision VALUES (1, 1)');
    this.ctx.storage.sql.exec(
      'CREATE TABLE sync_probe_snapshot(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO sync_probe_snapshot VALUES (1, ?)',
      JSON.stringify(this.indexSnapshot(0)),
    );
  }
  unchangedChecks(count: number) {
    this.probe.begin('unchanged-revision');
    for (let i = 0; i < count; i++)
      this.ctx.storage.sql
        .exec<{ revision: number }>('SELECT revision FROM sync_probe_revision WHERE id=1')
        .one();
    return this.probe.read();
  }
  persistedSnapshots(count: number) {
    this.probe.begin('persisted-snapshot');
    let returned = 0;
    for (let i = 0; i < count; i++) {
      const row = this.ctx.storage.sql
        .exec<{ payload: string }>('SELECT payload FROM sync_probe_snapshot WHERE id=1')
        .one();
      returned = JSON.parse(row.payload).conversations.length;
    }
    return { returned, counters: this.probe.read() };
  }
  candidateChange() {
    this.probe.begin('candidate-change');
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE conversations SET title='Changed synthetic title' WHERE id='synthetic-0'",
      );
      this.ctx.storage.sql.exec('UPDATE sync_probe_revision SET revision=revision+1 WHERE id=1');
    });
    const revision = this.ctx.storage.sql
      .exec<{ revision: number }>('SELECT revision FROM sync_probe_revision WHERE id=1')
      .one().revision;
    const snapshot = this.indexSnapshot(0);
    return {
      revision,
      changed: snapshot.conversations.some((item) => item.title === 'Changed synthetic title'),
      counters: this.probe.read(),
    };
  }
  evict() {
    this.ctx.abort('Synthetic cold-start measurement');
  }
}

export class ReadConversation extends Conversation {
  private readonly probe: FixtureResourceMeter;
  private readonly statements: StatementReads;
  constructor(ctx: DurableObjectState, env: Env) {
    const probe = new FixtureResourceMeter();
    const statements = new StatementReads();
    probe.begin('constructor');
    super(statements.wrap(probe.wrapState(ctx)), env);
    this.probe = probe;
    this.statements = statements;
  }
  counters() {
    return this.probe.read();
  }
  startWindow(name: string) {
    return this.probe.begin(name);
  }
  constructorStatements() {
    return this.statements.top();
  }
  pendingQueryPlan() {
    return this.ctx.storage.sql
      .exec(
        `EXPLAIN QUERY PLAN SELECT runs.* FROM runs JOIN messages
      ON messages.id = runs.assistantId AND messages.runId = runs.id
      WHERE messages.status IN ('queued', 'running')`,
      )
      .toArray()
      .map((row) => row.detail);
  }
  indexPendingMessages() {
    const query = `SELECT runs.id FROM runs JOIN messages
      ON messages.id = runs.assistantId AND messages.runId = runs.id
      WHERE messages.status IN ('queued', 'running') ORDER BY runs.id`;
    for (const [id, status] of [
      [0, 'queued'],
      [1, 'running'],
    ] as const)
      this.ctx.storage.sql.exec(
        'UPDATE messages SET status=?,runId=? WHERE id=?',
        status,
        `run-${id}`,
        `message-${id}`,
      );
    const before = this.ctx.storage.sql.exec(query).toArray();
    this.ctx.storage.sql.exec(
      "CREATE INDEX sync_probe_pending ON messages(status) WHERE status IN ('queued','running')",
    );
    const after = this.ctx.storage.sql.exec(query).toArray();
    this.ctx.storage.sql.exec(
      "UPDATE messages SET status='completed',runId=NULL WHERE status IN ('queued','running')",
    );
    return { before, after };
  }
  seed(count: number) {
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i < count; i++) {
        const id = `message-${i}`;
        this.ctx.storage.sql.exec(
          "INSERT INTO messages(id,role,content,status,createdAt) VALUES (?, 'assistant', 'Synthetic answer', 'completed', 1)",
          id,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO runs(id,conversationId,assistantId,context,updatedAt) VALUES (?, 'synthetic', ?, '[]', 1)",
          `run-${i}`,
          id,
        );
      }
    });
  }
  controlMessages(count: number, kind: 'session-check' | 'sync-check') {
    this.probe.begin(kind);
    const baseline = this.ctx.storage.sql
      .exec<{ seq: number; epoch: string }>('SELECT seq, epoch FROM conversation_state WHERE id=1')
      .one();
    this.probe.begin(kind);
    let sent = 0;
    const socket = {
      deserializeAttachment: () => ({
        expires: Date.now() / 1000 + 3600,
        revalidate: Date.now() / 1000 + 3600,
      }),
      send: () => sent++,
      close: () => {
        throw new Error('Unexpected synthetic socket close');
      },
    } as unknown as WebSocket;
    for (let i = 0; i < count; i++)
      this.webSocketMessage(
        socket,
        kind === 'session-check' ? kind : JSON.stringify({ type: kind, ...baseline }),
      );
    return { sent, counters: this.probe.read() };
  }
  async handshakes(count: number) {
    const baseline = this.ctx.storage.sql
      .exec<{ seq: number; epoch: string }>('SELECT seq, epoch FROM conversation_state WHERE id=1')
      .one();
    this.probe.begin('conversation-handshakes');
    for (let i = 0; i < count; i++) {
      const expiry = String(Math.floor(Date.now() / 1000) + 300);
      const response = await this.fetch(
        new Request(
          `https://synthetic.invalid/sync?after=${baseline.seq}&epoch=${baseline.epoch}`,
          {
            headers: {
              Upgrade: 'websocket',
              'X-Session-Expires': expiry,
              'X-Session-Revalidate': expiry,
            },
          },
        ),
      );
      if (response.status !== 101 || !response.webSocket)
        throw new Error('Conversation upgrade failed');
      response.webSocket.accept();
      response.webSocket.close(1000);
    }
    return this.probe.read();
  }
  evict() {
    this.ctx.abort('Synthetic cold-start measurement');
  }
}

export default {
  fetch() {
    return new Response('Local measurement fixture', { status: 404 });
  },
};
