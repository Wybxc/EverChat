import assert from 'node:assert/strict';
import { createDecipheriv, hkdfSync, type ECDH } from 'node:crypto';

/** Independent RFC 8291 receiver for unit tests and isolated platform measurements. */
export function decryptWebPush(receiver: ECDH, auth: Uint8Array, input: Uint8Array) {
  const body = Buffer.from(input),
    salt = body.subarray(0, 16),
    keyLength = body[20],
    sender = body.subarray(21, 21 + keyLength),
    publicKey = receiver.getPublicKey();
  assert.equal(keyLength, 65);
  const secret = receiver.computeSecret(sender),
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
    ),
    nonce = hkdfSync(
      'sha256',
      Buffer.from(ikm),
      salt,
      Buffer.from('Content-Encoding: nonce\0'),
      12,
    ),
    encrypted = body.subarray(21 + keyLength),
    decipher = createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  decipher.setAuthTag(encrypted.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  let end = plaintext.length;
  while (end > 0 && plaintext[end - 1] === 0) end--;
  assert.equal(plaintext[end - 1], 2);
  return plaintext.subarray(0, end - 1);
}
