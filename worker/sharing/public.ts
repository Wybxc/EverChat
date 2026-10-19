import type { Env } from '../http/env';
import { json } from '../http/response';
import { shareIdPattern, shareSecretPattern } from '../../shared/sharing/types';

export const publicHeaders = {
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
};
export async function publicSharing(request: Request, env: Env) {
  const url = new URL(request.url),
    match = /^\/public\/shares\/([^/]+)$/.exec(url.pathname);
  const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  const unavailable = () => json({ error: '链接不可用。' }, 404, publicHeaders);
  if (
    !['GET', 'HEAD'].includes(request.method) ||
    !match ||
    !shareIdPattern.test(match[1]) ||
    !token ||
    !shareSecretPattern.test(token) ||
    (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  )
    return unavailable();
  if (!env.SHARES) return json({ error: '分享服务暂时不可用。' }, 503, publicHeaders);
  try {
    const result = await env.SHARES.getByName('personal').read(
      match[1],
      token,
      request.method === 'HEAD',
    );
    const headers = new Headers(result.headers);
    for (const [name, value] of Object.entries(publicHeaders)) headers.set(name, value);
    // HEAD performs the same authorization. No conditional 304 can bypass revocation.
    return new Response(request.method === 'HEAD' ? null : result.body, {
      status: result.status,
      headers,
    });
  } catch {
    return json({ error: '分享服务暂时不可用。' }, 503, publicHeaders);
  }
}
