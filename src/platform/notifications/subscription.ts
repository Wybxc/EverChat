export class InvalidPushSubscriptionError extends Error {
  readonly code = 'PUSH_SUBSCRIPTION_INVALID';
  constructor() {
    super('The browser returned invalid push subscription keys. Enable notifications again.');
  }
}
import type { NotificationDevice } from '../../../shared/notifications/protocol';

type BrowserSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  getKey(name: 'auth' | 'p256dh'): ArrayBuffer | null;
};

/** Build the wire format explicitly; browser toJSON() dictionaries can omit nullable fields. */
export function serializePushSubscription(
  subscription: BrowserSubscription,
): NonNullable<NotificationDevice['subscription']> {
  const key = (name: 'auth' | 'p256dh', length: number) => {
    const value = subscription.getKey(name);
    if (!value || value.byteLength !== length) throw new InvalidPushSubscriptionError();
    return btoa(String.fromCharCode(...new Uint8Array(value)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  };
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: { auth: key('auth', 16), p256dh: key('p256dh', 65) },
  };
}
