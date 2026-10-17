import { requireAuth } from './access';
import type { ApiRouter } from './app';

export function registerSessionRoutes(app: ApiRouter, logoutUrl = '/cdn-cgi/access/logout') {
  app.get('/session', async (context) => {
    const { issuer, sub, email } = await requireAuth(context);
    return context.env.LIBRARY.getByName('personal').sessionResponse(
      { issuer, sub, email },
      logoutUrl,
    );
  });
}
