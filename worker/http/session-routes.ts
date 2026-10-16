import { requireAuth } from './access';
import type { ApiRouter } from './app';
import { json } from './response';

export function registerSessionRoutes(app: ApiRouter, logoutUrl = '/cdn-cgi/access/logout') {
  app.get('/session', async (context) => {
    const { issuer, sub, email } = await requireAuth(context);
    const settings = await context.env.LIBRARY.getByName('personal').sessionSettings();
    return json({ ...settings, authenticated: true, logoutUrl, identity: { issuer, sub, email } });
  });
}
