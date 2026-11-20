import * as v from 'valibot';
import { requireAuth, uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, parseBody, json } from '../http/response';
import { mcpOAuthConfig } from './oauth-config';

const nameSchema = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
  readSystemPrompts: v.optional(v.boolean()),
});
export function registerMcpRoutes(app: ApiRouter) {
  app.get('/settings/mcp/keys', async (context) => {
    await requireAuth(context);
    return json({
      keys: await context.env.LIBRARY.getByName('personal').mcpKeysList(),
      endpoint: `${context.env.APP_ORIGIN}/mcp`,
    });
  });
  app.post('/settings/mcp/keys', async (context) => {
    await requireAuth(context);
    const input = await parseBody(context, nameSchema, { maxBytes: 2048 });
    return json(
      await context.env.LIBRARY.getByName('personal').mcpKeyCreate(
        input.name,
        input.readSystemPrompts,
      ),
      201,
    );
  });
  app.patch('/settings/mcp/keys/:keyId', async (context) => {
    await requireAuth(context);
    const id = context.req.param('keyId');
    if (!v.is(uuidSchema, id)) throw new HttpError(404, '找不到这个密钥。');
    const input = await parseBody(context, nameSchema, { maxBytes: 2048 });
    const key = await context.env.LIBRARY.getByName('personal').mcpKeyRename(
      id,
      input.name,
      input.readSystemPrompts,
    );
    if (!key) throw new HttpError(404, '找不到这个密钥。');
    return json(key);
  });
  app.delete('/settings/mcp/keys/:keyId', async (context) => {
    await requireAuth(context);
    const id = context.req.param('keyId');
    if (!v.is(uuidSchema, id)) throw new HttpError(404, '找不到这个密钥。');
    await context.env.LIBRARY.getByName('personal').mcpKeyRevoke(id);
    return json({ ok: true });
  });
  app.get('/settings/mcp/oauth-grants', async (context) => {
    const owner = await requireAuth(context);
    const enabled = Boolean(mcpOAuthConfig(context.env));
    return json({
      enabled,
      connections: enabled
        ? await context.env.LIBRARY.getByName('personal').mcpOAuthList(owner)
        : [],
    });
  });
  app.delete('/settings/mcp/oauth-grants/:id', async (context) => {
    const owner = await requireAuth(context);
    const id = context.req.param('id');
    if (!v.is(uuidSchema, id)) throw new HttpError(404, '找不到这个授权。');
    await context.env.LIBRARY.getByName('personal').mcpOAuthRevoke(owner, id);
    return json({ ok: true });
  });
}
