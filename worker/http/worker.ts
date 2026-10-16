import { authReturnTo } from '../../shared/auth/navigation';
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
            return json({ error: error.message, code: error.code }, error.status);
          throw error;
        }
      }
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      return app.fetch(request, env, context);
    },
  };
}
