import * as v from 'valibot';

export const NOTIFICATION_CHANNEL = 'everchat:notifications';
export const NOTIFICATION_TTL = 60 * 60_000;
export const notificationModeSchema = v.picklist(['always', 'never', 'unfocused']);
export type NotificationMode = v.InferOutput<typeof notificationModeSchema>;
const uuid = v.pipe(v.string(), v.uuid());
const timestamp = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const subscriptionSchema = v.strictObject({
  endpoint: v.pipe(v.string(), v.maxLength(4096), v.url()),
  expirationTime: v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
  keys: v.strictObject({
    auth: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}={0,2}$/)),
    p256dh: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{87}=?$/)),
  }),
});
export const notificationDeviceSchema = v.strictObject({
  instanceId: uuid,
  revision: timestamp,
  mode: notificationModeSchema,
  subscription: v.nullable(subscriptionSchema),
});
export type NotificationDevice = v.InferOutput<typeof notificationDeviceSchema>;
export const completionSchema = v.strictObject({
  conversationId: uuid,
  messageId: uuid,
  completedAt: timestamp,
});
export type AnswerCompletion = v.InferOutput<typeof completionSchema>;
export const completionId = (completion: AnswerCompletion) =>
  `${completion.conversationId}:${completion.messageId}:completed`;
export const completionUrl = (completion: AnswerCompletion) =>
  `/c/${encodeURIComponent(completion.conversationId)}?branch=${encodeURIComponent(completion.messageId)}`;
export const completionIsRecent = (completion: AnswerCompletion, now = Date.now()) =>
  completion.completedAt <= now + 5000 && now < completion.completedAt + NOTIFICATION_TTL;
export const shouldNotify = (mode: NotificationMode, foreground: boolean) =>
  mode === 'always' || (mode === 'unfocused' && !foreground);

/** Subscription endpoints are outbound fetch targets, never arbitrary user URLs. */
export function allowedPushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      ([
        'fcm.googleapis.com',
        'updates.push.services.mozilla.com',
        'updates-autopush.stage.mozaws.net',
      ].includes(url.hostname) ||
        url.hostname.endsWith('.push.apple.com') ||
        url.hostname.endsWith('.notify.windows.com'))
    );
  } catch {
    return false;
  }
}

export type NotificationPacket =
  | { type: 'check'; id: string }
  | { type: 'local'; completion: AnswerCompletion; revision: number }
  | { type: 'ready' };
