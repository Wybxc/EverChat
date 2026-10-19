import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, problem } from '../../shared/errors/descriptor';

export const randomShareId = () => randomBytes(16).toString('base64url');
export const randomShareSecret = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function tokenMatches(token: string, hash: string) {
  const supplied = Buffer.from(tokenHash(token), 'hex'),
    expected = Buffer.from(hash, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function key(secret: string) {
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32)
    throw new AppError(problem('SHARE_INCOMPLETE'), '分享链接密钥尚未配置。');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
// Binding the share ID as additional data prevents ciphertext swaps between records.
export async function encryptToken(token: string, secret: string, id: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) },
    await key(secret),
    new TextEncoder().encode(token),
  );
  return `${Buffer.from(iv).toString('base64url')}.${Buffer.from(ciphertext).toString('base64url')}`;
}
export async function decryptToken(value: string, secret: string, id: string) {
  const [iv, ciphertext] = value.split('.');
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Buffer.from(iv, 'base64url'),
        additionalData: new TextEncoder().encode(id),
      },
      await key(secret),
      Buffer.from(ciphertext, 'base64url'),
    ),
  );
}
