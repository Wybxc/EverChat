import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { authenticateAccess } from '../../worker/http/auth';
import { HttpError } from '../../worker/http/response';
import type { Env } from '../../worker/http/env';
import {
  decodeValue,
  encodeValue,
  MIGRATION_TABLES,
  quoteIdentifier,
  type Statement,
  type StoreKind,
} from './storage-protocol';
// Retain the existing Workflow binding/export during this temporary deployment.
export { WebToolWorkflow } from '../../worker/web-tools/workflow';

export class Conversation extends DurableObject {
  // No application constructor, schema initialization or migration is run here.
  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
  async fetch(request: Request) {
    const input = (await request.json()) as {
      action: string;
      tables?: string[];
      table?: string;
      offset?: number;
      job?: string;
      page?: number;
      statements?: Statement[];
    };
    const sql = this.ctx.storage.sql;
    let result: unknown;
    if (input.action === 'catalog') {
      // The control-plane inventory can omit objects referenced by the app.
      // Read canonical names without starting the business Library constructor.
      const sources = [
        ['conversations', 'id'],
        ['conversation_deletions', 'id'],
        ['conversation_copies', 'id'],
        ['conversation_copies', 'sourceId'],
        ['archive_imports', 'id'],
      ];
      const tables = new Set(
        sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
          .toArray()
          .map(({ name }) => name),
      );
      const selects = sources
        .filter(([table]) => tables.has(table))
        .map(
          ([table, column]) =>
            `SELECT ${quoteIdentifier(column)} AS id FROM ${quoteIdentifier(table)}`,
        );
      result = selects.length
        ? sql
            .exec<{ id: string }>(
              `SELECT id FROM (${selects.join(' UNION ')}) WHERE id IS NOT NULL ORDER BY id LIMIT 256 OFFSET ?`,
              input.offset ?? 0,
            )
            .toArray()
            .map(({ id }) => id)
        : [];
    } else if (input.action === 'schema') {
      result = sql
        .exec<{ name: string; sql: string }>(
          "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY name",
        )
        .toArray()
        .filter(({ name }) => input.tables?.includes(name));
    } else if (input.action === 'indexes') {
      result = sql
        .exec<{ name: string; sql: string; table: string }>(
          "SELECT name, sql, tbl_name AS 'table' FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name",
        )
        .toArray()
        .filter((row) => input.tables?.includes(row.table));
    } else if (input.action === 'rows') {
      if (!input.tables?.includes(input.table!)) throw new Error('Table outside migration scope');
      const table = quoteIdentifier(input.table!);
      const keys = sql
        .exec<{ name: string; pk: number }>(`PRAGMA table_info(${table})`)
        .toArray()
        .filter(({ pk }) => pk)
        .sort((a, b) => a.pk - b.pk)
        .map(({ name }) => quoteIdentifier(name));
      const rows = [];
      let bytes = 0;
      for (const row of sql.exec(
        `SELECT * FROM ${table}${keys.length ? ` ORDER BY ${keys.join(',')}` : ''} LIMIT 32 OFFSET ?`,
        input.offset ?? 0,
      )) {
        const encoded = Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, encodeValue(value)]),
        );
        const size = new TextEncoder().encode(JSON.stringify(encoded)).byteLength;
        if (rows.length && bytes + size > 256 * 1024) break;
        rows.push(encoded);
        bytes += size;
      }
      result = rows;
    } else if (input.action === 'apply') {
      if (
        !input.job ||
        !Number.isSafeInteger(input.page) ||
        input.page! < 0 ||
        !input.statements?.length
      )
        throw new Error('Invalid migration patch');
      const digest = createHash('sha256').update(JSON.stringify(input.statements)).digest('hex');
      result = this.ctx.storage.transactionSync(() => {
        sql.exec(
          'CREATE TABLE IF NOT EXISTS ops_migration (id INTEGER PRIMARY KEY CHECK (id=1), job TEXT NOT NULL, page INTEGER NOT NULL, digest TEXT NOT NULL)',
        );
        const last = sql
          .exec<{ job: string; page: number; digest: string }>(
            'SELECT * FROM ops_migration WHERE id=1',
          )
          .toArray()[0];
        if (last?.job === input.job && last.page === input.page) {
          if (last.digest !== digest) throw new Error('Conflicting patch retry');
          return { page: last.page };
        }
        if (input.page !== (last?.job === input.job ? last.page + 1 : 0))
          throw new Error('Patch page gap');
        for (const statement of input.statements!)
          sql.exec(
            statement.sql,
            ...statement.args.map((value) => {
              const decoded = decodeValue(value);
              return decoded instanceof Uint8Array ? (decoded.buffer as ArrayBuffer) : decoded;
            }),
          );
        sql.exec(
          'INSERT INTO ops_migration VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET job=excluded.job, page=excluded.page, digest=excluded.digest',
          input.job!,
          input.page!,
          digest,
        );
        return { page: input.page };
      });
    } else if (input.action === 'receipt') {
      const exists = sql
        .exec("SELECT 1 FROM sqlite_master WHERE name='ops_migration'")
        .toArray().length;
      result = exists
        ? (sql.exec('SELECT job, page FROM ops_migration WHERE id=1').toArray()[0] ?? null)
        : null;
    } else if (input.action === 'cleanup') {
      sql.exec('DROP TABLE IF EXISTS ops_migration');
      result = { ok: true };
    } else throw new Error('Unknown maintenance action');
    return Response.json(result);
  }
}
export class Library extends Conversation {}

type OperationsEnv = {
  OPS_RUN_ID: string;
  OPS_ADMIN_EMAIL?: string;
  CONVERSATIONS: DurableObjectNamespace<Conversation>;
  LIBRARY: DurableObjectNamespace<Library>;
};
// Private service-binding transport used by the native integration harness.
// The temporary HTTP route below separately verifies the operator's Access JWT.
export class Operations extends WorkerEntrypoint<OperationsEnv> {
  fetch(request: Request) {
    return dispatch(request, this.env);
  }
}
async function dispatch(request: Request, env: OperationsEnv) {
  const url = new URL(request.url);
  if (url.pathname === '/identity') return Response.json({ runId: env.OPS_RUN_ID });
  if (url.pathname === '/catalog') {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid catalog offset');
    const response = await env.LIBRARY.getByName('personal').fetch(
      new Request('https://maintenance.invalid/', {
        method: 'POST',
        body: JSON.stringify({ action: 'catalog', offset }),
      }),
    );
    const names = (await response.json()) as string[];
    return Response.json(
      names.map((name) => ({
        kind: 'conversation',
        id: env.CONVERSATIONS.idFromName(name).toString(),
      })),
    );
  }
  const input = (await request.json()) as { kind: StoreKind; id: string; runId: string };
  if (
    input.runId !== env.OPS_RUN_ID ||
    !MIGRATION_TABLES[input.kind] ||
    !/^[a-f0-9]{64}$/.test(input.id)
  )
    throw new Error('Invalid maintenance target');
  const namespace = input.kind === 'conversation' ? env.CONVERSATIONS : env.LIBRARY;
  return namespace.get(namespace.idFromString(input.id)).fetch(
    new Request('https://maintenance.invalid/', {
      method: 'POST',
      body: JSON.stringify({ ...input, tables: MIGRATION_TABLES[input.kind] }),
    }),
  );
}
export default {
  async fetch(request: Request, env: OperationsEnv & Env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/__operations/')) {
      try {
        const identity = await authenticateAccess(request, env);
        if (!env.OPS_ADMIN_EMAIL || identity.email !== env.OPS_ADMIN_EMAIL.toLowerCase())
          throw new HttpError(403, '此身份不能执行运维操作。');
        if (request.method === 'POST' && request.headers.get('Origin') !== env.APP_ORIGIN)
          throw new HttpError(403, '无效来源。');
        const target = new URL(request.url);
        target.pathname = target.pathname.slice('/api/__operations'.length);
        return dispatch(new Request(target, request), env);
      } catch (error) {
        if (error instanceof HttpError)
          return Response.json({ error: error.message }, { status: error.status });
        throw error;
      }
    }
    return new Response('维护中，请稍后重试。', {
      status: 503,
      headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
    });
  },
};
