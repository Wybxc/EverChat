import { Hono } from 'hono';
import { registerAttachmentsRoutes } from '../attachments/routes';
import { registerBackupRoutes } from '../backup/routes';
import { registerConversationRoutes } from '../conversation/routes';
import { registerLibraryRoutes } from '../library/routes';
import { storageErrorMessage } from '../platform/resource-limits';
import { registerPresetsRoutes } from '../presets/routes';
import { registerProvidersRoutes } from '../providers/routes';
import { registerSearchRoutes } from '../search/routes';
import { registerWebToolsRoutes } from '../web-tools/routes';
import type { Env } from './env';
import { HttpError,json } from './response';
import { registerSessionRoutes } from './session-routes';

type AppEnv = { Bindings: Env };

export type ApiRouter = Hono<AppEnv, Record<never, never>, '/api'>;
export const app = new Hono<AppEnv>().basePath('/api');

app.use('*', async (context, next) => {
  const request = context.req.raw;
  const url = new URL(request.url);
  const mutation = !['GET', 'HEAD'].includes(request.method);
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  if ((mutation || upgrade) && request.headers.get('Origin') !== url.origin) throw new HttpError(403, '此请求来源不受信任。');
  await next();
});

registerSessionRoutes(app);
registerProvidersRoutes(app);
registerWebToolsRoutes(app);
registerPresetsRoutes(app);
registerLibraryRoutes(app);
registerSearchRoutes(app);
registerBackupRoutes(app);
registerAttachmentsRoutes(app);
registerConversationRoutes(app);

app.notFound(() => json({ error: '找不到这个接口。' }, 404));

app.onError((error) => {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  const storage = storageErrorMessage(error);
  if (storage) return json({ error: storage }, 507);
  console.error('EverChat request failed', error instanceof Error ? error.name : 'UnknownError');
  return json({ error: '服务暂时不可用，请稍后重试。' }, 500);
});
