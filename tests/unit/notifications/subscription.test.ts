import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { serializePushSubscription } from '../../../src/platform/notifications/subscription';
import { subscriptionSchema } from '../../../shared/notifications/protocol';

test('subscriptions with an omitted expiry produce a canonical, validated wire format without browser JSON extensions', () => {
  const auth = new Uint8Array(16).fill(255),
    p256dh = new Uint8Array(65).fill(254);
  p256dh[0] = 4;
  const browser = {
    endpoint: 'https://web.push.apple.com/fixture-ios',
    getKey: (name: 'auth' | 'p256dh') => (name === 'auth' ? auth : p256dh).buffer,
    toJSON: () => {
      throw new Error('Browser serialization must not be used');
    },
  };
  const result = serializePushSubscription(browser);
  assert.equal(result.expirationTime, null);
  assert.equal(result.keys.auth, Buffer.from(auth).toString('base64url'));
  assert.equal(result.keys.p256dh, Buffer.from(p256dh).toString('base64url'));
  assert.deepEqual(v.parse(subscriptionSchema, result), result);
  const { expirationTime: _expiry, ...withoutExpiry } = result;
  assert.deepEqual(v.parse(subscriptionSchema, withoutExpiry), result);
  assert.throws(
    () => serializePushSubscription({ ...browser, getKey: () => null }),
    /有效的推送订阅密钥/,
  );
});
