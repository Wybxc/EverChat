import { identityKey } from '../../shared/auth/types';
import { notificationDeviceSchema } from '../../shared/notifications/protocol';
import { requireAuth } from '../http/access';
import type { ApiRouter } from '../http/app';
import { json, parseBody } from '../http/response';
import { pushConfigured } from './push';

export function registerNotificationRoutes(app: ApiRouter) {
  app.get('/notifications/config', async (context) => {
    await requireAuth(context);
    return json({ publicKey: pushConfigured(context.env) ? context.env.VAPID_PUBLIC_KEY : null });
  });
  app.put('/notifications/device', async (context) => {
    const principal = await requireAuth(context);
    const input = await parseBody(context, notificationDeviceSchema, { maxBytes: 8192 });
    return context.env.LIBRARY.getByName('personal').saveNotificationDevice(
      identityKey(principal),
      input,
    );
  });
  app.get('/notifications/sync', async (context) =>
    context.env.LIBRARY.getByName('personal').notificationChannel(
      context.req.raw,
      await requireAuth(context),
      context.req.query('instance') ?? '',
    ),
  );
}
