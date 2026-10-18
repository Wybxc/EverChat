// Isolated notification-only measurement: production outbox, Library, Alarm and encryption.
// No production data, model calls, attachments, WebSockets or real push gateways.
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { completionSchema, notificationDeviceSchema } from '../../../shared/notifications/protocol';
import type { AnswerCompletion, NotificationDevice } from '../../../shared/notifications/protocol';
import { Library as ProductionLibrary } from '../../../worker/library/durable-object';
import { COMPLETION_OUTBOX_SCHEMA, CompletionOutbox } from '../../../worker/notifications/outbox';
import type { Env } from '../../../worker/http/env';
import { FixtureResourceMeter } from '../../../tests/support/runtime/resource-meter';

type ValidationEnv = Env & { VALIDATION_SECRET?: string };
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (
    url.origin !== 'https://web.push.apple.com' ||
    !/^\/everchat-notification-pipeline-validation\/[\da-f-]{36}$/.test(url.pathname) ||
    url.search ||
    request.method !== 'POST' ||
    request.headers.get('Content-Encoding') !== 'aes128gcm' ||
    !request.headers.get('Authorization')?.startsWith('vapid ') ||
    (await request.arrayBuffer()).byteLength !== 4096
  )
    throw new Error('Only an encrypted validation push is allowed');
  await new Promise((resolve) => setTimeout(resolve, 10));
  return new Response(null, { status: 201 });
};

export class Library extends ProductionLibrary {
  private readonly meter: FixtureResourceMeter;
  private readonly nativeStorage: DurableObjectStorage;
  private pushes = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    const nativeStorage = ctx.storage,
      meter = new FixtureResourceMeter();
    super(meter.wrapState(ctx), env);
    this.meter = meter;
    this.nativeStorage = nativeStorage;
  }
  async validationPrepare(id: string, windowId: string, devices: NotificationDevice[]) {
    this.create(id, 'Notification pipeline validation');
    for (const device of devices) await this.saveNotificationDevice('validation', device);
    this.meter.begin(windowId);
  }
  async validationDispose() {
    await this.nativeStorage.deleteAlarm();
    await this.nativeStorage.deleteAll();
    return { alarmAt: await this.nativeStorage.getAlarm() };
  }
  protected override async sendNotificationPush(
    device: NotificationDevice,
    completion: AnswerCompletion,
  ) {
    const result = await super.sendNotificationPush(device, completion);
    if (result.status === 201) this.pushes++;
    return result;
  }
  async validationReport() {
    const sql = this.nativeStorage.sql;
    return {
      report: this.meter.read(),
      pushes: this.pushes,
      deliveries: sql
        .exec<{ done: number; count: number }>(
          'SELECT done, COUNT(*) AS count FROM notification_deliveries GROUP BY done',
        )
        .toArray(),
      alarmAt: await this.nativeStorage.getAlarm(),
      databaseBytes: sql.databaseSize,
    };
  }
}

export class NotificationProducer extends DurableObject<ValidationEnv> {
  private readonly meter = new FixtureResourceMeter();
  private readonly outbox: CompletionOutbox;
  private readonly nativeStorage: DurableObjectStorage;
  constructor(ctx: DurableObjectState, env: ValidationEnv) {
    super(ctx, env);
    this.nativeStorage = ctx.storage;
    this.meter.wrapState(ctx);
    ctx.storage.sql.exec(COMPLETION_OUTBOX_SCHEMA);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_target (name TEXT NOT NULL)');
    this.outbox = new CompletionOutbox(ctx.storage.sql.exec.bind(ctx.storage.sql));
  }
  prepare(caseId: string, windowId: string) {
    if (this.ctx.storage.sql.exec('SELECT name FROM fixture_target').toArray().length)
      throw new Error('Each validation case must use a new producer');
    this.ctx.storage.sql.exec('INSERT INTO fixture_target VALUES (?)', caseId);
    this.meter.begin(windowId);
  }
  async complete(completion: AnswerCompletion) {
    this.ctx.storage.transactionSync(() => this.outbox.record(completion));
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
  async alarm() {
    const name = this.nativeStorage.sql
      .exec<{ name: string }>('SELECT name FROM fixture_target')
      .one().name;
    const library = this.env.LIBRARY.getByName(name);
    await this.outbox.flush((completion) => library.answerCompleted(completion));
    const next = this.outbox.nextAlarm();
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, next));
  }
  report() {
    return {
      report: this.meter.read(),
      pending: this.nativeStorage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM answer_notification_outbox')
        .one().count,
      databaseBytes: this.nativeStorage.sql.databaseSize,
    };
  }
  async dispose() {
    await this.nativeStorage.deleteAlarm();
    await this.nativeStorage.deleteAll();
    return { alarmAt: await this.nativeStorage.getAlarm() };
  }
}

const uuid = v.pipe(v.string(), v.uuid());
const prepareSchema = v.strictObject({
  caseId: uuid,
  windowId: uuid,
  devices: v.pipe(v.array(notificationDeviceSchema), v.maxLength(9)),
});
const startSchema = v.strictObject({ caseId: uuid, completion: completionSchema });
export default {
  async fetch(request, env) {
    if (!env.VALIDATION_SECRET) return new Response('Unconfigured', { status: 503 });
    if (request.headers.get('Authorization') !== `Bearer ${env.VALIDATION_SECRET}`)
      return new Response('Unauthorized', { status: 401 });
    const url = new URL(request.url);
    const library = (id: string) =>
      (env.LIBRARY as unknown as DurableObjectNamespace<Library>).getByName(id);
    const producer = (id: string) =>
      (env.CONVERSATIONS as unknown as DurableObjectNamespace<NotificationProducer>).getByName(id);
    if (url.pathname === '/identity')
      return Response.json({
        kind: 'everchat-notification-pipeline-validation',
        mockGateway: true,
      });
    if (url.pathname === '/prepare' && request.method === 'POST') {
      const { caseId, windowId, devices } = v.parse(prepareSchema, await request.json());
      await library(caseId).validationPrepare(caseId, windowId, devices);
      await producer(caseId).prepare(caseId, windowId);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/start' && request.method === 'POST') {
      const { caseId, completion } = v.parse(startSchema, await request.json());
      if (completion.conversationId !== caseId)
        return new Response('Invalid case', { status: 400 });
      await producer(caseId).complete(completion);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/report') {
      const id = v.parse(uuid, url.searchParams.get('case'));
      return Response.json({
        producer: await producer(id).report(),
        library: await library(id).validationReport(),
      });
    }
    if (url.pathname === '/cleanup' && request.method === 'POST') {
      const { caseId } = v.parse(v.strictObject({ caseId: uuid }), await request.json());
      return Response.json({
        producer: await producer(caseId).dispose(),
        library: await library(caseId).validationDispose(),
      });
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<ValidationEnv>;
