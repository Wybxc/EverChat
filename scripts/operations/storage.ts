import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { unstable_readConfig } from 'wrangler';
import { cloudflareRead } from '../measurements/support/cloudflare-api';
import { migrateStorage } from './migrate-storage';
import {
  MIGRATION_TABLES,
  decodeValue,
  encodeValue,
  quoteIdentifier,
  type StoreKind,
  type Statement,
  type TableSchema,
  type IndexSchema,
  type WireValue,
} from './storage-protocol';

type Target = { kind: StoreKind; id: string };
type Manifest = { runId: string; account: string; worker: string; objects: Target[] };
type Snapshot = {
  schema: TableSchema[];
  indexes: IndexSchema[];
  rows: Record<string, Record<string, WireValue>[]>;
};
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    directory: { type: 'string' },
    account: { type: 'string' },
    config: { type: 'string', default: 'wrangler.jsonc' },
    'access-token-file': { type: 'string' },
  },
});
const action = positionals[0];
assert.ok(
  ['prepare', 'preflight', 'backup', 'convert', 'apply', 'verify', 'cleanup', 'rollback'].includes(
    action,
  ),
  'Usage: pnpm ops:storage prepare|preflight|backup|convert|apply|verify|cleanup|rollback --directory <private-directory> [--account <id>]',
);
assert.ok(values.directory, '--directory is required');
const directory = resolve(values.directory);
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const save = async (file: string, value: unknown) => {
  const temporary = join(directory, `${file}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, file));
};
const load = async <T>(file: string) =>
  JSON.parse(await readFile(join(directory, file), 'utf8')) as T;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hasFile = async (file: string) =>
  Boolean(await stat(join(directory, file)).catch(() => null));

if (action === 'prepare') {
  assert.ok(values.account && /^[a-f0-9]{32}$/.test(values.account), '--account is required');
  assert.ok(
    !(await hasFile('manifest.json')),
    'Use a new directory; never overwrite an operations run',
  );
  const source = unstable_readConfig({ config: values.config });
  const worker = source.name!;
  const emails = String(source.vars.ACCESS_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  assert.equal(emails.length, 1, 'Maintenance requires one explicit administrator email');
  const objects = await listTargets(values.account, worker);
  const manifest: Manifest = { runId: randomUUID(), account: values.account, worker, objects };
  await save('manifest.json', manifest);
  await save('maintenance.json', {
    name: worker,
    account_id: values.account,
    main: resolve('scripts/operations/maintenance-worker.ts'),
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags,
    durable_objects: source.durable_objects,
    migrations: source.migrations,
    workflows: source.workflows,
    r2_buckets: source.r2_buckets,
    routes: source.routes,
    workers_dev: source.workers_dev,
    preview_urls: source.preview_urls,
    vars: { ...source.vars, OPS_RUN_ID: manifest.runId, OPS_ADMIN_EMAIL: emails[0] },
    observability: source.observability,
  });
  console.log(
    JSON.stringify({
      prepared: true,
      objects: objects.length,
      maintenanceConfig: join(directory, 'maintenance.json'),
    }),
  );
} else {
  const manifest = await load<Manifest>('manifest.json');
  const base = ({ kind, id }: Target) => `${kind}-${id}`;
  if (action === 'preflight') {
    const { origin, headers } = await accessConnection();
    const response = await fetch(`${origin}/auth/resume?returnTo=%2F`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 303, 'Access preflight failed; do not enter maintenance');
    assert.equal(response.headers.get('Location'), '/', 'Unexpected Access preflight redirect');
    await response.body?.cancel();
    console.log(JSON.stringify({ preflight: true, authenticated: true, databaseRequests: 0 }));
  } else if (action === 'convert') {
    assert.ok(await hasFile('backup-complete.json'), 'Back up every target before conversion');
    for (const target of manifest.objects) {
      const prefix = base(target),
        snapshot = await load<Snapshot>(`${prefix}.before.json`);
      if (await hasFile(`${prefix}.patch.json`)) continue;
      const path = join(directory, `${prefix}.sqlite`);
      // Only disposable conversion copies are recreated. A crashed SQLite
      // transaction can leave a hot journal; it must not recover over a new copy.
      for (const suffix of ['', '-journal', '-wal', '-shm'])
        await rm(`${path}${suffix}`, { force: true });
      await writeFile(path, '', { mode: 0o600, flag: 'wx' });
      const db = new DatabaseSync(path);
      try {
        for (const table of snapshot.schema) {
          db.exec(table.sql);
          for (const row of snapshot.rows[table.name]) {
            const keys = Object.keys(row);
            db.prepare(
              `INSERT INTO ${quoteIdentifier(table.name)} (${keys.map(quoteIdentifier).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
            ).run(...(Object.values(row).map(decodeValue) as SQLInputValue[]));
          }
        }
        for (const index of snapshot.indexes) db.exec(index.sql);
        const patch = migrateStorage(db, target.kind);
        db.exec('VACUUM');
        await save(`${prefix}.after.json`, localSnapshot(db, target.kind));
        // The patch is the per-object completion marker. Publish it only after
        // its matching expected snapshot exists, so interrupted conversion can retry.
        await save(`${prefix}.patch.json`, {
          job: `${manifest.runId}:${hash(patch)}`,
          statements: patch,
        });
      } finally {
        db.close();
      }
    }
    await save('conversion-complete.json', { objects: manifest.objects.length });
    console.log(
      JSON.stringify({ converted: true, objects: manifest.objects.length, remoteRequests: 0 }),
    );
  } else {
    const { origin, headers } = await accessConnection();
    const send = async (path: string, init: RequestInit = {}) =>
      fetch(`${origin}/api/__operations${path}`, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
        headers,
      });
    {
      const identityResponse = await send('/identity');
      assert.equal(identityResponse.status, 200, 'Cannot authenticate to the maintenance endpoint');
      const identity = (await identityResponse.json()) as { runId: string };
      assert.equal(
        identity.runId,
        manifest.runId,
        'The deployed Worker is not this maintenance run',
      );
      const call = async <T>(target: Target, input: Record<string, unknown>): Promise<T> => {
        const response = await send('/', {
          method: 'POST',
          body: JSON.stringify({ ...target, ...input, runId: manifest.runId }),
        });
        if (!response.ok)
          throw new Error(`Maintenance ${input.action} failed: HTTP ${response.status}`);
        return response.json() as Promise<T>;
      };
      const discoverTargets = async () => {
        const targets = await listTargets(manifest.account, manifest.worker);
        let offset = 0;
        while (true) {
          const response = await send(`/catalog?offset=${offset}`);
          assert.equal(response.status, 200, 'Cannot inspect canonical conversation catalog');
          const page = (await response.json()) as Target[];
          if (!page.length) break;
          targets.push(...page);
          offset += page.length;
        }
        return [
          ...new Map(targets.map((target) => [`${target.kind}:${target.id}`, target])).values(),
        ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
      };
      const snapshot = async (target: Target): Promise<Snapshot> => {
        const schema = await call<TableSchema[]>(target, { action: 'schema' }),
          rows: Snapshot['rows'] = {};
        for (const table of schema) {
          const values: Record<string, WireValue>[] = [];
          while (true) {
            const page = await call<Record<string, WireValue>[]>(target, {
              action: 'rows',
              table: table.name,
              offset: values.length,
            });
            if (!page.length) break;
            values.push(...page);
          }
          rows[table.name] = values;
        }
        const indexes = await call<IndexSchema[]>(target, { action: 'indexes' });
        return { schema, indexes, rows };
      };
      if (action === 'backup') {
        assert.ok(
          !(await hasFile('conversion-complete.json')),
          'Do not overwrite a backup after conversion',
        );
        manifest.objects = await discoverTargets();
        await save('manifest.json', manifest);
        for (const target of manifest.objects) {
          const file = `${base(target)}.before.json`;
          if (!(await hasFile(file))) await save(file, await snapshot(target));
        }
        await save('backup-complete.json', { objects: manifest.objects.length });
      } else if (action === 'apply') {
        assert.ok(
          await hasFile('conversion-complete.json'),
          'Convert every object locally before writing any patch',
        );
        for (const target of manifest.objects) {
          const patch = await load<{ job: string; statements: Statement[] }>(
            `${base(target)}.patch.json`,
          );
          const receipt = await call<{ job: string; page: number } | null>(target, {
            action: 'receipt',
          });
          assert.ok(!receipt || receipt.job === patch.job, 'Another migration owns this object');
          const pages = patchPages(patch.statements);
          for (let page = (receipt?.page ?? -1) + 1; page < pages.length; page++)
            await call(target, { action: 'apply', job: patch.job, page, statements: pages[page] });
        }
        await save('apply-complete.json', { objects: manifest.objects.length });
      } else if (action === 'verify') {
        assert.deepEqual(
          await discoverTargets(),
          manifest.objects,
          'Namespace inventory changed during maintenance',
        );
        assert.ok(await hasFile('apply-complete.json'), 'Import every patch before verification');
        for (const target of manifest.objects) {
          const expected = await load<Snapshot>(`${base(target)}.after.json`);
          assert.equal(
            hash(await snapshot(target)),
            hash(expected),
            `Verification failed for ${base(target)}`,
          );
        }
        await save('verified.json', {
          objects: manifest.objects.length,
          verifiedAt: new Date().toISOString(),
        });
      } else if (action === 'cleanup') {
        assert.ok(
          (await hasFile('verified.json')) || (await hasFile('rolled-back.json')),
          'Verify every target before cleanup',
        );
        for (const target of manifest.objects) await call(target, { action: 'cleanup' });
      } else if (action === 'rollback') {
        assert.ok(
          await hasFile('backup-complete.json'),
          'Rollback requires complete original backups',
        );
        for (const target of manifest.objects) {
          const before = await load<Snapshot>(`${base(target)}.before.json`);
          const statements: Statement[] = MIGRATION_TABLES[target.kind].map((table) => ({
            sql: `DROP TABLE IF EXISTS ${quoteIdentifier(table)}`,
            args: [],
          }));
          for (const table of before.schema) {
            statements.push({ sql: table.sql, args: [] });
            for (const row of before.rows[table.name]) {
              const keys = Object.keys(row);
              statements.push({
                sql: `INSERT INTO ${quoteIdentifier(table.name)} (${keys.map(quoteIdentifier).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
                args: Object.values(row),
              });
            }
          }
          for (const index of before.indexes) statements.push({ sql: index.sql, args: [] });
          const job = `${manifest.runId}:rollback:${hash(statements)}`;
          const receipt = await call<{ job: string; page: number } | null>(target, {
            action: 'receipt',
          });
          const pages = patchPages(statements);
          for (let page = receipt?.job === job ? receipt.page + 1 : 0; page < pages.length; page++)
            await call(target, { action: 'apply', job, page, statements: pages[page] });
          assert.equal(
            hash(await snapshot(target)),
            hash(before),
            `Rollback verification failed for ${base(target)}`,
          );
        }
        await save('rolled-back.json', { objects: manifest.objects.length });
      }
      console.log(JSON.stringify({ [action]: true, objects: manifest.objects.length }));
    }
  }
}

function localSnapshot(db: DatabaseSync, kind: StoreKind): Snapshot {
  const schema = (
    db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY name",
      )
      .all() as unknown as TableSchema[]
  ).filter(({ name }) => MIGRATION_TABLES[kind].includes(name));
  const rows: Snapshot['rows'] = {};
  const indexes = (
    db
      .prepare(
        "SELECT name, sql, tbl_name AS 'table' FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name",
      )
      .all() as unknown as IndexSchema[]
  ).filter((row) => MIGRATION_TABLES[kind].includes(row.table));
  for (const table of schema) {
    const keys = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`)
      .all()
      .filter(({ pk }) => pk)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map(({ name }) => quoteIdentifier(String(name)));
    rows[table.name] = db
      .prepare(
        `SELECT * FROM ${quoteIdentifier(table.name)}${keys.length ? ` ORDER BY ${keys.join(',')}` : ''}`,
      )
      .all()
      .map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encodeValue(value)])),
      );
  }
  return { schema, indexes, rows };
}
function patchPages(statements: Statement[]) {
  const pages: Statement[][] = [];
  let page: Statement[] = [],
    bytes = 0;
  for (const statement of statements) {
    const size = Buffer.byteLength(JSON.stringify(statement));
    if (page.length && (bytes + size > 256 * 1024 || page.length >= 64)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(statement);
    bytes += size;
  }
  if (page.length) pages.push(page);
  return pages;
}

async function listTargets(account: string, worker: string): Promise<Target[]> {
  const response = await cloudflareRead<{
    bindings: { name: string; namespace_id?: string; type: string }[];
  }>(`/accounts/${account}/workers/scripts/${worker}/settings`);
  assert.ok(
    response.success && response.result,
    `Cannot inspect production bindings: HTTP ${response.status}`,
  );
  const objects: Target[] = [];
  for (const [name, kind] of [
    ['CONVERSATIONS', 'conversation'],
    ['LIBRARY', 'library'],
  ] as const) {
    const namespace: string | undefined = response.result.bindings.find(
      (binding) => binding.name === name && binding.type === 'durable_object_namespace',
    )?.namespace_id;
    assert.ok(namespace, `Missing ${name} namespace`);
    let cursor = '';
    do {
      const page = (await cloudflareRead<{ id: string; hasStoredData: boolean }[]>(
        `/accounts/${account}/workers/durable_objects/namespaces/${namespace}/objects?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )) as Awaited<ReturnType<typeof cloudflareRead<{ id: string; hasStoredData: boolean }[]>>> & {
        result_info?: { cursor?: string };
      };
      assert.ok(page.success && page.result, `Cannot enumerate ${name}: HTTP ${page.status}`);
      for (const object of page.result) {
        assert.equal(
          typeof object.hasStoredData,
          'boolean',
          'Cannot determine object storage status',
        );
        if (object.hasStoredData) objects.push({ kind, id: object.id });
      }
      const next = page.result_info?.cursor ?? '';
      assert.ok(!next || next !== cursor, 'Namespace cursor did not advance');
      assert.ok(page.result.length < 1000 || next, 'Cannot prove complete namespace enumeration');
      cursor = next;
    } while (cursor);
  }
  assert.ok(
    objects.some(({ kind }) => kind === 'library'),
    'No stored Library object found',
  );
  return objects.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

async function accessConnection() {
  const source = unstable_readConfig({ config: values.config });
  const origin = String(source.vars.APP_ORIGIN ?? '');
  assert.equal(
    new URL(origin).protocol,
    'https:',
    'Maintenance requires the configured HTTPS origin',
  );
  const token = (
    await readFile(values['access-token-file'] ?? join(directory, 'access-token'), 'utf8')
  ).trim();
  assert.ok(/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token), 'A cloudflared Access JWT file is required');
  return {
    origin,
    headers: {
      'cf-access-token': token,
      Origin: origin,
      'Content-Type': 'application/json',
    },
  };
}
