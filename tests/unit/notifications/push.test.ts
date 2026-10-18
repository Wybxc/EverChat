import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { jwtVerify } from 'jose';
import { sendWebPush } from '../../../worker/notifications/push';
import type { Env } from '../../../worker/http/env';
import type { NotificationDevice } from '../../../shared/notifications/protocol';

test('Web Push uses independently decryptable RFC 8291 aes128gcm and a valid endpoint-bound VAPID signature', async (t) => {
  const ua = createECDH('prime256v1'),
    as = createECDH('prime256v1');
  ua.generateKeys();
  as.generateKeys();
  const auth = randomBytes(16),
    publicKey = ua.getPublicKey();
  const device: NotificationDevice = {
    instanceId: crypto.randomUUID(),
    revision: 1,
    mode: 'always',
    subscription: {
      endpoint: 'https://web.push.apple.com/push/test',
      expirationTime: null,
      keys: { auth: auth.toString('base64url'), p256dh: publicKey.toString('base64url') },
    },
  };
  const env = {
    VAPID_PUBLIC_KEY: as.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: as.getPrivateKey().toString('base64url'),
    VAPID_SUBJECT: 'mailto:notifications@example.com',
  } as Env;
  const completion = {
    conversationId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    completedAt: Date.now(),
  };
  let captured: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    assert.equal(url, device.subscription!.endpoint);
    captured = options;
    return new Response(null, { status: 201 });
  });
  assert.equal((await sendWebPush(env, device, completion)).status, 201);
  assert.equal(captured?.redirect, 'error');
  const headers = new Headers(captured!.headers);
  assert.equal(headers.get('Content-Encoding'), 'aes128gcm');
  assert.ok(Number(headers.get('TTL')) > 0 && Number(headers.get('TTL')) <= 3600);
  const authorization = headers.get('Authorization')!,
    token = /\bt=([^, ]+)/.exec(authorization)![1];
  const pk = as.getPublicKey();
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pk.subarray(1, 33).toString('base64url'),
      y: pk.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
  const verified = await jwtVerify(token, key, {
    audience: 'https://web.push.apple.com',
    algorithms: ['ES256'],
  });
  assert.equal(verified.payload.sub, env.VAPID_SUBJECT);
  const body = Buffer.from(captured!.body as Uint8Array),
    salt = body.subarray(0, 16),
    keyLength = body[20],
    sender = body.subarray(21, 21 + keyLength);
  const secret = ua.computeSecret(sender),
    ikm = hkdfSync(
      'sha256',
      secret,
      auth,
      Buffer.concat([Buffer.from('WebPush: info\0'), publicKey, sender]),
      32,
    );
  const cek = hkdfSync(
    'sha256',
    Buffer.from(ikm),
    salt,
    Buffer.from('Content-Encoding: aes128gcm\0'),
    16,
  );
  const nonce = hkdfSync(
    'sha256',
    Buffer.from(ikm),
    salt,
    Buffer.from('Content-Encoding: nonce\0'),
    12,
  );
  const encrypted = body.subarray(21 + keyLength),
    decipher = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  decipher.setAuthTag(encrypted.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  let end = plaintext.length;
  while (end > 0 && plaintext[end - 1] === 0) end--;
  assert.equal(plaintext[end - 1], 2);
  assert.deepEqual(JSON.parse(plaintext.subarray(0, end - 1).toString()), {
    channel: 'everchat:notifications',
    ...completion,
  });
});
