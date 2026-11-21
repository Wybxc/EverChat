import * as v from 'valibot';
import { remoteMcpConnectionSchema } from '../../shared/tools/remote-mcp';
import { problem } from '../../shared/errors/descriptor';
import { requireAuth, uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, json, parseBody } from '../http/response';

export function registerRemoteMcpRoutes(app: ApiRouter) {
  app.get('/settings/remote-mcp', async (context) => {
    await requireAuth(context);
    return json(await context.env.LIBRARY.getByName('personal').listRemoteMcp());
  });
  app.put('/settings/remote-mcp/:id', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id');
    if (!v.is(uuidSchema, id))
      throw new HttpError(400, '连接 ID 无效。', undefined, problem('INVALID_REQUEST'));
    const input = await parseBody(context, remoteMcpConnectionSchema, {
      maxBytes: 8192,
      tooLarge: '连接参数过长。',
    });
    return json(await context.env.LIBRARY.getByName('personal').saveRemoteMcp(id, input));
  });
  app.delete('/settings/remote-mcp/:id', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id');
    if (!v.is(uuidSchema, id))
      throw new HttpError(404, '找不到连接。', undefined, problem('NOT_FOUND'));
    await context.env.LIBRARY.getByName('personal').removeRemoteMcp(id);
    return json({ ok: true });
  });
  app.get('/settings/remote-mcp/:id/tools', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id');
    if (!v.is(uuidSchema, id))
      throw new HttpError(404, '找不到连接。', undefined, problem('NOT_FOUND'));
    try {
      return json(await context.env.LIBRARY.getByName('personal').remoteMcpCatalog(id));
    } catch {
      throw new HttpError(
        502,
        '无法读取远程 MCP 工具，请检查地址和凭据。',
        undefined,
        problem('PROVIDER_FAILED'),
      );
    }
  });
}
