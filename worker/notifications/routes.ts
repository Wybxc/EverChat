import * as v from 'valibot';
import { identityKey } from '../../shared/auth/types';
import { notificationDeviceSchema } from '../../shared/notifications/protocol';
import { requireAuth } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, json, parseBody } from '../http/response';
import { pushConfigured } from './push';

export function registerNotificationRoutes(app: ApiRouter) {
  app.get('/notifications/config', async (context) => {
    await requireAuth(context);
    return json({ publicKey: pushConfigured(context.env) ? context.env.VAPID_PUBLIC_KEY : null });
  });
  app.put('/notifications/device', async (context) => {
    const principal = await requireAuth(context);
    const raw = await parseBody(context, v.unknown(), { maxBytes: 8192 });
    const parsed = v.safeParse(notificationDeviceSchema, raw);
    if (!parsed.success) {
      const known = new Set([
        'instanceId',
        'revision',
        'mode',
        'subscription',
        'subscription.endpoint',
        'subscription.expirationTime',
        'subscription.keys',
        'subscription.keys.auth',
        'subscription.keys.p256dh',
      ]);
      const fields = [
        ...new Set(
          parsed.issues
            .map((issue) => issue.path?.map((entry) => entry.key).join('.') ?? '')
            .filter((path) => known.has(path)),
        ),
      ];
      // Field names aid diagnosis without echoing subscription values or validator input.
      throw new HttpError(
        400,
        `通知订阅格式无效${fields.length ? `（${fields.join('、')}）` : ''}，请更新应用后重新启用。`,
        'INVALID_NOTIFICATION_DEVICE',
      );
    }
    const input = parsed.output;
    return context.env.LIBRARY.getByName('personal').saveNotificationDevice(
      identityKey(principal),
      input,
    );
  });
  app.get('/notifications/sync', async (context) => {
    const principal = await requireAuth(context);
    // A WebSocket upgrade must use fetch transport rather than RPC serialization.
    // Rebuild internal headers so client-supplied identity or expiry cannot survive.
    const headers = new Headers({
      Upgrade: context.req.header('Upgrade') ?? '',
      'X-Notification-Owner': identityKey(principal),
      'X-Session-Expires': String(principal.expires),
    });
    return context.env.LIBRARY.getByName('personal').fetch(
      new Request(context.req.raw, { headers }),
    );
  });
}
