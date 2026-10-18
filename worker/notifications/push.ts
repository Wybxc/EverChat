import { buildPushPayload } from '@block65/webcrypto-web-push';
import {
  allowedPushEndpoint,
  NOTIFICATION_TTL,
  type AnswerCompletion,
  type NotificationDevice,
} from '../../shared/notifications/protocol';
import type { Env } from '../http/env';

export type PushResult = { status: number; retryAfter?: number };
export const pushConfigured = (env: Env) =>
  Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

export async function sendWebPush(
  env: Env,
  device: NotificationDevice,
  completion: AnswerCompletion,
): Promise<PushResult> {
  if (!device.subscription || !allowedPushEndpoint(device.subscription.endpoint))
    return { status: 410 };
  if (!pushConfigured(env)) return { status: 503 };
  const payload = await buildPushPayload(
    {
      data: { channel: 'everchat:notifications', ...completion },
      options: {
        ttl: Math.max(
          0,
          Math.ceil((completion.completedAt + NOTIFICATION_TTL - Date.now()) / 1000),
        ),
        urgency: 'normal',
      },
    },
    device.subscription,
    {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    },
  );
  const response = await fetch(device.subscription.endpoint, {
    ...payload,
    // Workers supports manual redirects. Never forward VAPID credentials to a new URL.
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const retry = response.headers.get('Retry-After');
  await response.body?.cancel();
  return {
    status: response.status,
    retryAfter: retry
      ? Number.isFinite(Number(retry))
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now()
      : undefined,
  };
}
