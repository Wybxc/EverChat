import type { Env } from './env';

const encoder = new TextEncoder();
const COOKIE = 'everchat_session';
const TTL = 60 * 60 * 24 * 30;
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');

async function key(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export async function passwordMatches(input: string, expected: string) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(input)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a),
    right = new Uint8Array(b);
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left[i] ^ right[i];
  return different === 0;
}
export async function authenticated(request: Request, env: Env) {
  if (!env.SESSION_SECRET || !env.APP_PASSWORD) return false;
  const cookie = request.headers
    .get('Cookie')
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!cookie) return false;
  const [expires, nonce, signature, extra] = cookie.split('.');
  if (
    extra ||
    !/^\d+$/.test(expires ?? '') ||
    Number(expires) <= Date.now() / 1000 ||
    !/^[0-9a-f]{32}$/.test(nonce ?? '') ||
    !/^[0-9a-f]{64}$/.test(signature ?? '')
  )
    return false;
  const bytes = Uint8Array.from(signature.match(/../g)!, (x) => parseInt(x, 16));
  return crypto.subtle.verify(
    'HMAC',
    await key(env.SESSION_SECRET),
    bytes,
    encoder.encode(`${expires}.${nonce}`),
  );
}
function cookieOptions(request: Request) {
  return `Path=/; HttpOnly; SameSite=Strict${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function sessionCookie(request: Request, secret: string) {
  const expires = Math.floor(Date.now() / 1000) + TTL;
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const value = `${expires}.${nonce}`;
  const signature = hex(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(value)));
  return `${COOKIE}=${value}.${signature}; Max-Age=${TTL}; ${cookieOptions(request)}`;
}
export const logoutCookie = (request: Request) =>
  `${COOKIE}=; Max-Age=0; ${cookieOptions(request)}`;
