import { webToolServiceInputSchema } from '../../shared/web-tools/service';
import { requireAuth } from '../http/access';
import type { ApiRouter } from '../http/app';
import { json, parseBody } from '../http/response';

export function registerWebToolsRoutes(app: ApiRouter) {
  app.get('/settings/web-tools', async (context) => {
    await requireAuth(context);
    return json(await context.env.LIBRARY.getByName('personal').webToolSettings());
  });

  app.get('/settings/web-tools/key', async (context) => {
    await requireAuth(context);
    return json({ apiKey: await context.env.LIBRARY.getByName('personal').webToolKey() });
  });

  app.put('/settings/web-tools', async (context) => {
    await requireAuth(context);
    const input = await parseBody(context, webToolServiceInputSchema, {
      maxBytes: 8192,
      tooLarge: '联网工具设置超过 8 KiB。',
    });
    return json(await context.env.LIBRARY.getByName('personal').saveWebToolSettings(input));
  });
}
