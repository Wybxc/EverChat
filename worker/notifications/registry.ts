import * as v from 'valibot';
import {
  allowedPushEndpoint,
  completionId,
  completionIsRecent,
  completionSchema,
  NOTIFICATION_TTL,
  notificationDeviceSchema,
  type AnswerCompletion,
  type NotificationDevice,
  type NotificationPacket,
} from '../../shared/notifications/protocol';
import type { SqlQuery } from '../generation/metrics';
import { HttpError } from '../http/response';
import type { PushResult } from './push';

const schemas = [
  `CREATE TABLE IF NOT EXISTS notification_devices (id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL, enabledAt INTEGER NOT NULL, payload TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT NOT NULL, device TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL, expires INTEGER NOT NULL, nextAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, checkToken TEXT, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(id, device))`,
  'CREATE INDEX IF NOT EXISTS notification_pending ON notification_deliveries(done, nextAt)',
  'CREATE INDEX IF NOT EXISTS notification_expiry ON notification_deliveries(expires)',
];
type DeviceRow = {
  id: string;
  owner: string;
  revision: number;
  enabledAt: number;
  payload: string;
} & Record<string, SqlStorageValue>;
type DeliveryRow = {
  id: string;
  device: string;
  revision: number;
  payload: string;
  createdAt: number;
  expires: number;
  attempts: number;
  checkToken: string | null;
} & Record<string, SqlStorageValue>;
type Connection = {
  instanceId: string;
  owner: string;
  expires: number;
};

export class NotificationRegistry {
  private sending = false;
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly query: SqlQuery,
    private readonly send: (
      device: NotificationDevice,
      completion: AnswerCompletion,
    ) => Promise<PushResult>,
    private readonly exists: (id: string) => boolean,
    private readonly now = Date.now,
  ) {
    for (const sql of schemas) query(sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private row(id: string) {
    return this.query<DeviceRow>(
      'SELECT * FROM notification_devices WHERE id = ?',
      id,
    ).toArray()[0];
  }
  save(owner: string, input: NotificationDevice) {
    const device = v.parse(notificationDeviceSchema, input);
    if (device.subscription && !allowedPushEndpoint(device.subscription.endpoint))
      throw new HttpError(400, '不支持此推送服务地址。');
    const old = this.row(device.instanceId);
    if (old && old.owner !== owner) throw new HttpError(403, '通知实例不属于此账号。');
    if (old && old.revision >= device.revision)
      return JSON.parse(old.payload) as NotificationDevice;
    const enabledAt =
      !old || (JSON.parse(old.payload) as NotificationDevice).mode === 'never'
        ? this.now()
        : old.enabledAt;
    const value = device.mode === 'never' ? { ...device, subscription: null } : device;
    this.query(
      `INSERT INTO notification_devices VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, enabledAt=excluded.enabledAt, payload=excluded.payload`,
      value.instanceId,
      owner,
      value.revision,
      enabledAt,
      JSON.stringify(value),
    );
    this.query(
      'UPDATE notification_deliveries SET done = 1 WHERE device = ? AND revision != ? AND done = 0',
      value.instanceId,
      value.revision,
    );
    return value;
  }
  connect(request: Request, owner: string, expires: number, instanceId: string) {
    const device = this.row(instanceId);
    if (!device || device.owner !== owner) throw new HttpError(403, '请先启用此实例的通知。');
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      throw new HttpError(426, '需要实时连接。');
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [instanceId]);
    pair[1].serializeAttachment({
      instanceId,
      owner: device.owner,
      expires,
    } satisfies Connection);
    pair[1].send(JSON.stringify({ type: 'ready' } satisfies NotificationPacket));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  message(socket: WebSocket, data: string | ArrayBuffer) {
    const connection = socket.deserializeAttachment() as Connection | null;
    if (!connection || connection.expires * 1000 <= this.now()) {
      socket.close(4401, 'Session expired');
      return;
    }
    if (typeof data !== 'string' || data.length > 512) return;
    try {
      const value = JSON.parse(data);
      if (
        value.type === 'check' &&
        typeof value.id === 'string' &&
        value.id.length < 180 &&
        value.foreground === true
      ) {
        // Complete only this delivery's current check. Keeping one reply on the
        // socket loses other completions and lets stale replies overwrite it.
        const separator = value.id.lastIndexOf(':');
        if (separator > 0)
          this.query(
            'UPDATE notification_deliveries SET done = 1 WHERE id = ? AND device = ? AND checkToken = ? AND done = 0 AND nextAt > ?',
            value.id.slice(0, separator),
            connection.instanceId,
            value.id,
            this.now(),
          );
      }
      if (value.type === 'session-check') socket.send('pong');
    } catch {
      /* Invalid control messages cannot change a subscription. */
    }
  }
  private sockets(instanceId: string) {
    return this.ctx.getWebSockets(instanceId).filter((socket) => {
      const data = socket.deserializeAttachment() as Connection | null;
      if (
        !data ||
        data.expires * 1000 <= this.now() ||
        this.row(instanceId)?.owner !== data.owner
      ) {
        socket.close(4401, 'Session expired');
        return false;
      }
      return socket.readyState === WebSocket.OPEN;
    });
  }
  enqueue(input: AnswerCompletion) {
    const completion = v.parse(completionSchema, input);
    if (!completionIsRecent(completion, this.now()) || !this.exists(completion.conversationId))
      return;
    const id = completionId(completion);
    for (const row of this.query<DeviceRow>(
      'SELECT * FROM notification_devices WHERE enabledAt <= ?',
      completion.completedAt,
    ).toArray()) {
      const device = JSON.parse(row.payload) as NotificationDevice;
      if (device.mode === 'never') continue;
      this.query(
        `INSERT OR IGNORE INTO notification_deliveries(id, device, revision, payload, createdAt, expires, nextAt) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        id,
        row.id,
        row.revision,
        JSON.stringify(completion),
        this.now(),
        completion.completedAt + NOTIFICATION_TTL,
        this.now(),
      ).toArray();
    }
  }
  nextAlarm() {
    const pending = this.query<{ next: number | null }>(
      'SELECT MIN(nextAt) AS next FROM notification_deliveries WHERE done = 0',
    ).one().next;
    const expiry = this.query<{ next: number | null }>(
      'SELECT MIN(expires) AS next FROM notification_deliveries',
    ).one().next;
    return Math.min(pending ?? Infinity, expiry ?? Infinity);
  }
  async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      this.query('DELETE FROM notification_deliveries WHERE expires <= ?', this.now());
      for (const job of this.query<DeliveryRow>(
        'SELECT * FROM notification_deliveries WHERE done = 0 AND nextAt <= ? ORDER BY nextAt LIMIT 8',
        this.now(),
      ).toArray()) {
        const row = this.row(job.device),
          device = row && (JSON.parse(row.payload) as NotificationDevice | undefined);
        const completion = JSON.parse(job.payload) as AnswerCompletion;
        if (
          !device ||
          device.mode === 'never' ||
          device.revision !== job.revision ||
          !this.exists(completion.conversationId)
        ) {
          this.done(job);
          continue;
        }
        const sockets = this.sockets(job.device);
        if (!device.subscription) {
          for (const socket of sockets) {
            try {
              socket.send(
                JSON.stringify({
                  type: 'local',
                  completion,
                  revision: device.revision,
                } satisfies NotificationPacket),
              );
            } catch {}
          }
          this.done(job);
          continue;
        }
        if (
          device.subscription.expirationTime !== null &&
          device.subscription.expirationTime <= this.now()
        ) {
          this.query(
            'UPDATE notification_devices SET payload = ? WHERE id = ?',
            JSON.stringify({ ...device, subscription: null }),
            job.device,
          );
          this.done(job);
          continue;
        }
        if (device.mode === 'unfocused' && sockets.length && !job.checkToken) {
          const token = `${job.id}:${crypto.randomUUID()}`;
          for (const socket of sockets) {
            try {
              socket.send(
                JSON.stringify({ type: 'check', id: token } satisfies NotificationPacket),
              );
            } catch {}
          }
          this.query(
            'UPDATE notification_deliveries SET checkToken = ?, nextAt = ? WHERE id = ? AND device = ?',
            token,
            this.now() + 1000,
            job.id,
            job.device,
          );
          continue;
        }
        const started = this.now();
        let result: PushResult, errorType: string | undefined;
        try {
          result = await this.send(device, completion);
        } catch (error) {
          result = { status: 503 };
          // Error messages may contain subscription URLs or credentials.
          errorType =
            error instanceof Error &&
            [
              'Error',
              'TypeError',
              'TimeoutError',
              'AbortError',
              'DataError',
              'OperationError',
              'NotSupportedError',
              'InvalidAccessError',
            ].includes(error.name)
              ? error.name
              : 'UnknownError';
        }
        const accepted = result.status >= 200 && result.status < 300,
          expired = [404, 410].includes(result.status),
          retryable = [408, 429].includes(result.status) || result.status >= 500;
        console.info('EverChat notification delivery', {
          completionId: job.id,
          instanceId: device.instanceId,
          attempt: job.attempts + 1,
          status: result.status,
          result: accepted
            ? 'accepted'
            : expired
              ? 'invalid-subscription'
              : retryable
                ? 'retry'
                : 'rejected',
          elapsedMs: Math.max(0, this.now() - started),
          ...(errorType ? { errorType } : {}),
        });
        if (accepted) {
          this.done(job);
          continue;
        }
        if (expired) {
          if (this.row(job.device)?.revision === job.revision)
            this.query(
              'UPDATE notification_devices SET payload = ? WHERE id = ?',
              JSON.stringify({ ...device, subscription: null }),
              job.device,
            );
          this.done(job);
          continue;
        }
        if (!retryable) {
          this.done(job);
          continue;
        }
        this.query(
          'UPDATE notification_deliveries SET attempts = attempts + 1, checkToken = NULL, nextAt = ? WHERE id = ? AND device = ? AND done = 0',
          Math.min(
            job.expires,
            this.now() +
              Math.max(
                1000,
                Math.min(
                  NOTIFICATION_TTL,
                  result.retryAfter ?? Math.min(300_000, 1000 * 2 ** Math.min(job.attempts, 9)),
                ),
              ),
          ),
          job.id,
          job.device,
        );
      }
    } finally {
      this.sending = false;
    }
  }
  private done(job: DeliveryRow) {
    this.query(
      'UPDATE notification_deliveries SET done = 1 WHERE id = ? AND device = ?',
      job.id,
      job.device,
    );
  }
}
