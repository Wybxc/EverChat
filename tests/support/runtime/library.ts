import {
  completionId,
  type AnswerCompletion,
  type NotificationDevice,
} from '../../../shared/notifications/protocol';
import { AttachmentStore } from '../../../worker/attachments/store';
import type { Env } from '../../../worker/http/env';
import { HttpError } from '../../../worker/http/response';
import { Library as ProductionLibrary } from '../../../worker/index';
import type { MeasurementEnv } from './env';
import { FixtureResourceMeter } from './resource-meter';
import type { ConversationActivity } from '../../../shared/conversation/activity';

export type ActivityControl = { id: string; fail?: boolean; report?: ConversationActivity };

export type AttachmentControl = {
  id?: string;
  expire?: boolean;
  count?: number;
  reset?: boolean;
  holdDelete?: string;
  releaseDelete?: boolean;
  failDelete?: string;
  holdTextPut?: string;
  holdTextRead?: string;
  releaseText?: boolean;
  resetLibrary?: boolean;
  unconfigured?: boolean;
  expireCopy?: string;
  expireImport?: string;
  noBucket?: boolean;
};
export class Library extends ProductionLibrary {
  private notificationFixture() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_notification_pushes (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL, completionId TEXT NOT NULL, payload TEXT NOT NULL)',
    );
  }
  protected override async sendNotificationPush(
    device: NotificationDevice,
    completion: AnswerCompletion,
  ) {
    this.notificationFixture();
    this.ctx.storage.sql.exec(
      'INSERT INTO fixture_notification_pushes(device, completionId, payload) VALUES (?, ?, ?)',
      device.instanceId,
      completionId(completion),
      JSON.stringify(completion),
    );
    return { status: 201 };
  }
  async fixtureNotifications(completion?: AnswerCompletion) {
    this.notificationFixture();
    if (completion) await this.answerCompleted(completion);
    return {
      pushes: this.ctx.storage.sql
        .exec('SELECT device, completionId, payload FROM fixture_notification_pushes')
        .toArray(),
      pending: this.ctx.storage.sql
        .exec('SELECT id, device, done FROM notification_deliveries')
        .toArray(),
      devices: this.ctx.storage.sql.exec('SELECT id, revision FROM notification_devices').toArray(),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  private activityFixture() {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_activity (id TEXT PRIMARY KEY, fail INTEGER NOT NULL, calls INTEGER NOT NULL)',
    );
  }
  override reportActivity(id: string, activity: ConversationActivity) {
    this.activityFixture();
    const row = this.ctx.storage.sql
      .exec<{ fail: number }>(
        'INSERT INTO fixture_activity VALUES (?, 0, 1) ON CONFLICT(id) DO UPDATE SET calls = calls + 1 RETURNING fail',
        id,
      )
      .one();
    if (row.fail) throw new Error('Injected lifecycle report failure');
    return super.reportActivity(id, activity);
  }
  fixtureActivity({ id, fail, report }: ActivityControl) {
    this.activityFixture();
    if (fail !== undefined)
      this.ctx.storage.sql.exec(
        'INSERT INTO fixture_activity VALUES (?, ?, 0) ON CONFLICT(id) DO UPDATE SET fail = excluded.fail',
        id,
        Number(fail),
      );
    if (report) super.reportActivity(id, report);
    return {
      ...this.ctx.storage.sql.exec('SELECT * FROM fixture_activity WHERE id = ?', id).toArray()[0],
      activity: this.indexSnapshot(0).activity[id] ?? null,
    };
  }
  private readonly resourceMeter?: FixtureResourceMeter;
  private readonly resourceStorage: DurableObjectStorage;
  async fixtureResourceControl(windowId?: string) {
    if (!this.resourceMeter) throw new Error('Local resource measurement is disabled');
    if (windowId) this.resourceMeter.begin(windowId);
    const sql = this.resourceStorage.sql;
    const alarmAt = await this.resourceStorage.getAlarm();
    return {
      report: this.resourceMeter.read(),
      databaseBytes: sql.databaseSize,
      alarmAt,
      pendingBackfills: sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM search_backfill WHERE done = 0')
        .one().count,
      usedToday: sql
        .exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM web_tool_requests WHERE day = ?',
          new Date().toISOString().slice(0, 10),
        )
        .one().count,
    };
  }
  async fixtureResetWebTools() {
    await this.ctx.storage.sync();
    this.ctx.abort('Intentional Library reset during web tools', { retryAlarm: true });
  }
  private attachmentDeletes: {
    id: string;
    waiting: boolean;
    wait: Promise<void>;
    release: () => void;
  }[];
  private attachmentText: {
    id: string;
    kind: 'put' | 'get';
    waiting: boolean;
    wait: Promise<void>;
    release: () => void;
  }[];
  private fixtureBucket?: R2Bucket;
  constructor(ctx: DurableObjectState, env: Env) {
    const resourceStorage = ctx.storage;
    const resourceMeter =
      (env as MeasurementEnv).LOCAL_RESOURCE_METRICS === '1'
        ? new FixtureResourceMeter()
        : undefined;
    if (resourceMeter) ctx = resourceMeter.wrapState(ctx);
    const attachmentText: Library['attachmentText'] = [];
    const attachmentDeletes: Library['attachmentDeletes'] = [];
    const bucket = env.ATTACHMENTS
      ? new Proxy(env.ATTACHMENTS, {
          get(target, property) {
            if (property === 'delete')
              return async (keys: string | string[]) => {
                const exists = ctx.storage.sql
                  .exec(
                    "SELECT name FROM sqlite_master WHERE name = 'fixture_attachment_delete_fault'",
                  )
                  .toArray().length;
                const fault = exists
                  ? ctx.storage.sql
                      .exec<{ id: string; remaining: number }>(
                        'SELECT id, remaining FROM fixture_attachment_delete_fault WHERE remaining > 0',
                      )
                      .toArray()[0]
                  : undefined;
                if (
                  fault &&
                  (Array.isArray(keys) ? keys : [keys]).some((key) => key.includes(`/${fault.id}/`))
                ) {
                  ctx.storage.sql.exec(
                    'UPDATE fixture_attachment_delete_fault SET remaining = remaining - 1, failed = failed + 1 WHERE id = ?',
                    fault.id,
                  );
                  await ctx.storage.sync();
                  throw new Error('Injected R2 delete failure');
                }
                const pause = attachmentDeletes.find((item) =>
                  (Array.isArray(keys) ? keys : [keys]).some((key) => key.includes(`/${item.id}/`)),
                );
                if (pause) {
                  pause.waiting = true;
                  await pause.wait;
                }
                return target.delete(keys);
              };
            if (property === 'get')
              return async (...args: Parameters<R2Bucket['get']>) => {
                const pause = attachmentText.find(
                  (item) =>
                    item.kind === 'get' &&
                    args[0].endsWith('/text-v1') &&
                    args[0].includes(`/${item.id}/`),
                );
                if (pause) {
                  pause.waiting = true;
                  await pause.wait;
                }
                return target.get(...args);
              };
            if (property === 'put')
              return async (...args: Parameters<R2Bucket['put']>) => {
                const pause = attachmentText.find(
                  (item) =>
                    item.kind === 'put' &&
                    args[0].endsWith('/text-v1') &&
                    args[0].includes(`/${item.id}/`),
                );
                if (pause) {
                  pause.waiting = true;
                  await pause.wait;
                }
                const object = await target.put(...args);
                const exists = ctx.storage.sql
                  .exec("SELECT name FROM sqlite_master WHERE name = 'fixture_attachment_reset'")
                  .toArray().length;
                if (
                  exists &&
                  ctx.storage.sql
                    .exec<{ enabled: number }>(
                      'SELECT enabled FROM fixture_attachment_reset WHERE id = 1',
                    )
                    .toArray()[0]?.enabled
                ) {
                  ctx.storage.sql.exec(
                    'UPDATE fixture_attachment_reset SET enabled = 0 WHERE id = 1',
                  );
                  await ctx.storage.sync();
                  ctx.abort('Intentional reset after R2 put', { retryAlarm: true });
                }
                return object;
              };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      : undefined;
    const disabled =
      ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'fixture_r2_disabled'")
        .toArray().length &&
      ctx.storage.sql
        .exec<{ enabled: number }>('SELECT enabled FROM fixture_r2_disabled WHERE id = 1')
        .toArray()[0]?.enabled;
    super(ctx, { ...env, ATTACHMENTS: disabled ? undefined : bucket });
    this.resourceMeter = resourceMeter;
    this.resourceStorage = resourceStorage;
    this.fixtureBucket = bucket;
    this.attachmentDeletes = attachmentDeletes;
    this.attachmentText = attachmentText;
  }
  override applySearchDocuments(
    id: string,
    documents: Parameters<ProductionLibrary['applySearchDocuments']>[1],
  ) {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_index_fault (id INTEGER PRIMARY KEY, enabled INTEGER)',
    );
    if (
      this.ctx.storage.sql
        .exec<{ enabled: number }>('SELECT enabled FROM fixture_index_fault WHERE id = 1')
        .toArray()[0]?.enabled
    )
      throw new Error('Injected index RPC failure');
    return super.applySearchDocuments(id, documents);
  }
  async fixtureSearchControl(id?: string, fail?: boolean, rebuild?: boolean) {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_index_fault (id INTEGER PRIMARY KEY, enabled INTEGER)',
    );
    if (fail !== undefined)
      this.ctx.storage.sql.exec(
        'INSERT INTO fixture_index_fault VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled',
        Number(fail),
      );
    if (id && rebuild) {
      this.ctx.storage.sql.exec(
        'INSERT INTO search_backfill(conversationId, after, done) VALUES (?, 0, 0) ON CONFLICT(conversationId) DO UPDATE SET after = 0, done = 0, nextAt = 0, attempts = 0',
        id,
      );
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    return {
      fields: this.ctx.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM search_fields')
        .one().count,
      versions: this.ctx.storage.sql
        .exec('SELECT messageId, version FROM search_messages WHERE conversationId = ?', id ?? '')
        .toArray(),
      progress:
        this.ctx.storage.sql
          .exec('SELECT * FROM search_backfill WHERE conversationId = ?', id ?? '')
          .toArray()[0] ?? null,
    };
  }
  fixtureDeletionHistory(count: number) {
    if (!Number.isInteger(count) || count < 0 || count > 600)
      throw new Error('Invalid deletion fixture count');
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_deletion_ids (id TEXT PRIMARY KEY)',
    );
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'DELETE FROM conversation_deletions WHERE id IN (SELECT id FROM fixture_deletion_ids)',
      );
      this.ctx.storage.sql.exec('DELETE FROM fixture_deletion_ids');
      for (let index = 0; index < count; index++) {
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec('INSERT INTO fixture_deletion_ids VALUES (?)', id);
        this.ctx.storage.sql.exec(
          'INSERT INTO conversation_deletions VALUES (?, ?, 1)',
          id,
          Date.now(),
        );
      }
    });
  }
  fixtureSupplierCall(id: string) {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_supplier_calls (id TEXT PRIMARY KEY, calls INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      'INSERT INTO fixture_supplier_calls VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET calls = calls + 1',
      id,
    );
  }
  fixtureSupplierCalls(id: string) {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_supplier_calls (id TEXT PRIMARY KEY, calls INTEGER NOT NULL)',
    );
    return (
      this.ctx.storage.sql
        .exec<{ calls: number }>('SELECT calls FROM fixture_supplier_calls WHERE id = ?', id)
        .toArray()[0]?.calls ?? 0
    );
  }
  fixtureCapacity(seed: boolean) {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      // Remove derived jobs before deleting their fixture owners; otherwise Library Alarm keeps selecting an orphan.
      sql.exec(
        "DELETE FROM search_backfill WHERE conversationId IN (SELECT id FROM conversations WHERE title = '__capacity_fixture__')",
      );
      sql.exec("DELETE FROM conversations WHERE title = '__capacity_fixture__'");
      if (seed) {
        const count = sql
          .exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversations')
          .one().count;
        for (let index = count; index < 128; index++)
          this.create(crypto.randomUUID(), '__capacity_fixture__');
      }
    });
    return {
      count: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM conversations').one().count,
    };
  }
  async fixtureAttachments({
    id,
    expire,
    count,
    reset,
    holdDelete,
    releaseDelete,
    failDelete,
    holdTextPut,
    holdTextRead,
    releaseText,
    resetLibrary,
    unconfigured,
    expireCopy,
    expireImport,
    noBucket,
  }: AttachmentControl) {
    const date = new Date().toISOString().slice(0, 10),
      sql = this.ctx.storage.sql;
    // Seed a retired counter only in fixtures, to prove it no longer gates uploads.
    sql.exec(
      'CREATE TABLE IF NOT EXISTS attachment_daily_uploads (date TEXT PRIMARY KEY, count INTEGER NOT NULL)',
    );
    if (releaseText) this.attachmentText.splice(0).forEach((pause) => pause.release());
    for (const [kind, id] of [
      ['put', holdTextPut],
      ['get', holdTextRead],
    ] as const)
      if (id) {
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        this.attachmentText.push({ id, kind, waiting: false, wait, release });
      }
    if (releaseDelete) this.attachmentDeletes.splice(0).forEach((pause) => pause.release());
    if (holdDelete) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.attachmentDeletes.push({ id: holdDelete, waiting: false, wait, release });
    }
    if (expire && id) {
      sql.exec('UPDATE attachments SET lease = 0 WHERE id = ?', id);
      sql.exec(
        "UPDATE attachment_documents SET lease = 0 WHERE id = ? AND status IN ('parsing', 'cleaning')",
        id,
      );
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    if (expireCopy) {
      sql.exec(
        "UPDATE conversation_copies SET lease = 0 WHERE id = ? AND status = 'copying'",
        expireCopy,
      );
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    if (expireImport) {
      sql.exec('UPDATE archive_imports SET lease = 0, cleanupAt = 0 WHERE id = ?', expireImport);
      sql.exec('UPDATE attachments SET lease = 0 WHERE conversationId = ?', expireImport);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    if (noBucket !== undefined) {
      sql.exec(
        'CREATE TABLE IF NOT EXISTS fixture_r2_disabled (id INTEGER PRIMARY KEY, enabled INTEGER)',
      );
      sql.exec(
        'INSERT INTO fixture_r2_disabled VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled',
        Number(noBucket),
      );
      await this.ctx.storage.sync();
      this.ctx.abort('Intentional Library restart with changed R2 binding', { retryAlarm: true });
    }
    if (count !== undefined)
      sql.exec(
        'INSERT INTO attachment_daily_uploads VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET count = excluded.count',
        date,
        count,
      );
    if (reset !== undefined) {
      sql.exec(
        'CREATE TABLE IF NOT EXISTS fixture_attachment_reset (id INTEGER PRIMARY KEY, enabled INTEGER)',
      );
      sql.exec(
        'INSERT INTO fixture_attachment_reset VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled',
        Number(reset),
      );
    }
    sql.exec(
      'CREATE TABLE IF NOT EXISTS fixture_attachment_delete_fault (id TEXT PRIMARY KEY, remaining INTEGER, failed INTEGER)',
    );
    if (failDelete)
      sql.exec(
        'INSERT INTO fixture_attachment_delete_fault VALUES (?, 1, 0) ON CONFLICT(id) DO UPDATE SET remaining = 1, failed = 0',
        failDelete,
      );
    if (resetLibrary) {
      await this.ctx.storage.sync();
      this.ctx.abort('Intentional Library reset during R2 cleanup', { retryAlarm: true });
    }
    const unconfiguredStatus: number[] = [];
    if (unconfigured) {
      const store = new AttachmentStore(this.ctx.storage, undefined, () => true);
      for (const action of [
        () => store.list('unconfigured'),
        () =>
          store.register('unconfigured', {
            id: crypto.randomUUID(),
            name: 'blocked.txt',
            size: 1,
            sha256: 'a'.repeat(64),
            mediaType: 'text/plain',
          }),
      ]) {
        try {
          action();
          unconfiguredStatus.push(200);
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          unconfiguredStatus.push(error.status);
        }
      }
    }
    return {
      imports: sql
        .exec('SELECT id, status, lease, removed, cleanupAt, errorStatus FROM archive_imports')
        .toArray(),
      copies: sql
        .exec('SELECT id, sourceId, messageId, status, lease, errorStatus FROM conversation_copies')
        .toArray(),
      pdfMetadataIds: sql.exec('SELECT id FROM attachment_pdf_metadata').toArray(),
      documents: sql
        .exec('SELECT id, status, lease, characters, tokens, bytes FROM attachment_documents')
        .toArray(),
      textWaiting: this.attachmentText.some((pause) => pause.waiting),
      rows: sql
        .exec('SELECT id, conversationId, status, removed, lease FROM attachments')
        .toArray(),
      deleteWaiting: this.attachmentDeletes.some((pause) => pause.waiting),
      failedDeletes: sql
        .exec<{ count: number }>(
          'SELECT COALESCE(SUM(failed), 0) AS count FROM fixture_attachment_delete_fault',
        )
        .one().count,
      unconfiguredStatus,
      dailyCount:
        sql
          .exec<{ count: number }>(
            'SELECT count FROM attachment_daily_uploads WHERE date = ?',
            date,
          )
          .toArray()[0]?.count ?? 0,
      alarm: await this.ctx.storage.getAlarm(),
      objects: this.fixtureBucket
        ? (await this.fixtureBucket.list({ limit: 1000 })).objects.map((object) => ({
            key: object.key,
            size: object.size,
          }))
        : [],
    };
  }
}
