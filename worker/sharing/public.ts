import { problem } from '../../shared/errors/descriptor';
import { shareIdPattern } from '../../shared/sharing/types';
import { SHARE_CSP } from '../../shared/sharing/security';
import { resolveLocale } from '../../shared/i18n/locale';
import type { Env } from '../http/env';
import { json } from '../http/response';

export const publicHeaders = {
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
};
const unavailable = () =>
  json({ error: '链接不可用。', issue: problem('SHARE_UNAVAILABLE') }, 404, publicHeaders);
export async function publicSharing(request: Request, env: Env) {
  const url = new URL(request.url);
  const match = /^\/public\/shares\/([^/]+)\/status$/.exec(url.pathname);
  if (
    !['GET', 'HEAD'].includes(request.method) ||
    !match ||
    !shareIdPattern.test(match[1]) ||
    (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) ||
    request.headers.get('Sec-Fetch-Site') === 'cross-site'
  )
    return unavailable();
  try {
    if (!env.SHARES) throw new Error('Missing shares');
    const result = await env.SHARES.getByName('personal').status(match[1]);
    return new Response(request.method === 'HEAD' ? null : result.body, {
      status: result.status,
      headers: { ...Object.fromEntries(result.headers), ...publicHeaders },
    });
  } catch {
    return json(
      { error: '分享服务暂时不可用。', issue: problem('SHARE_INCOMPLETE') },
      503,
      publicHeaders,
    );
  }
}
export async function publicShareDocument(request: Request, env: Env) {
  const url = new URL(request.url);
  const match = /^\/s\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
  const locale = resolveLocale(
    'system',
    (request.headers.get('Accept-Language') ?? '')
      .split(',')
      .map((part) => part.split(';')[0].trim()),
  );
  const headers = {
    ...publicHeaders,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': SHARE_CSP,
  };
  let templateResponse: Response;
  try {
    templateResponse = await env.ASSETS.fetch(
      new Request(new URL('/share.html', url.origin), { method: 'GET' }),
    );
  } catch {
    return new Response(request.method === 'HEAD' ? null : 'Share document unavailable', {
      status: 503,
      headers,
    });
  }
  const template = await templateResponse.text();
  const errorDocument = (status: number) => {
    const text =
      locale === 'zh-CN'
        ? status === 404
          ? '链接不可用。'
          : '暂时无法读取，请稍后重试。'
        : status === 404
          ? 'This link is unavailable.'
          : 'Could not load. Try again later.';
    const page = template
      .replace('lang="en"', `lang="${locale}"`)
      .replace('__EVERCHAT_SHARE_TITLE__', 'EverChat')
      .replace('__EVERCHAT_SHARE_ID__', '')
      .replace('__EVERCHAT_SHARE_EXPIRY__', '')
      .replace(
        '<!--EVERCHAT_SHARE-->',
        `<main class="mx-auto w-full max-w-[49rem] px-4 py-6" role="alert">${text}<p><a href="" class="underline">${locale === 'zh-CN' ? '重新读取' : 'Reload'}</a></p></main>`,
      );
    return new Response(request.method === 'HEAD' ? null : page, { status, headers });
  };
  if (!templateResponse.ok || !template.includes('<!--EVERCHAT_SHARE-->'))
    return new Response('Share document unavailable', { status: 503, headers });
  if (!['GET', 'HEAD'].includes(request.method) || !match) return errorDocument(404);
  try {
    if (!env.SHARES) throw new Error('Missing shares');
    const result = await env.SHARES.getByName('personal').document(
      match[1],
      template,
      locale,
      request.method === 'HEAD',
    );
    if (!result.ok) {
      await result.body?.cancel();
      return errorDocument(result.status === 404 ? 404 : 503);
    }
    return new Response(request.method === 'HEAD' ? null : result.body, {
      status: result.status,
      headers,
    });
  } catch {
    return errorDocument(503);
  }
}
