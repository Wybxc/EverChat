import * as v from 'valibot';
import { requireAuth, uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, parseBody, json } from '../http/response';

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
}
