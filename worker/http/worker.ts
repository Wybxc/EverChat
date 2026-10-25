import { authReturnTo } from '../../shared/auth/navigation';
import { problem } from '../../shared/errors/descriptor';
import { publicSharing } from '../sharing/public';
import { serveMcp } from '../mcp/handler';
import { serveMcpAttachment } from '../mcp/attachment-http';
import { createApi } from './app';
import { authenticateAccess, type Authenticator } from './auth';
import type { Env } from './env';
import { HttpError, json } from './response';

export function createWorker(
  authenticate: Authenticator = authenticateAccess,
  localLogin?: string,
) {
  const app = createApi(
    authenticate,
    localLogin ? '/__dev/access/logout' : '/cdn-cgi/access/logout',
  );
  return {
    async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === '/mcp' && url.origin === env.APP_ORIGIN) return serveMcp(request, env);
      if (url.pathname.startsWith('/mcp/attachments/') && url.origin === env.APP_ORIGIN)
        return serveMcpAttachment(request, env);
      if (/^\/mcp(?:\/|$)/.test(url.pathname)) return json({ error: 'Not found.' }, 404);
      if (/^\/public(?:\/|$)/.test(url.pathname)) return publicSharing(request, env);
      if (url.pathname === '/auth/resume') {
        const target = authReturnTo(url.searchParams.get('returnTo'), url.origin);
        try {
          await authenticate(request, env);
          return new Response(null, {
            status: 303,
            headers: { Location: target, 'Cache-Control': 'no-store' },
          });
        } catch (error) {
          if (localLogin && error instanceof HttpError && error.status === 401)
            return new Response(null, {
              status: 303,
              headers: {
                Location: `${localLogin}?returnTo=${encodeURIComponent(target)}`,
                'Cache-Control': 'no-store',
              },
            });
          if (error instanceof HttpError)
            return json(
              { error: error.message, code: error.code, issue: error.issue },
              error.status,
            );
          throw error;
        }
      }
      if (/^\/auth(?:\/|$)/.test(url.pathname))
        return json({ error: '找不到这个接口。', issue: problem('NOT_FOUND') }, 404);
      if (!/^\/api(?:\/|$)/.test(url.pathname)) return env.ASSETS.fetch(request);
      return app.fetch(request, env, context);
    },
  };
}
