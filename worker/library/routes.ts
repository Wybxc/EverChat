import * as v from 'valibot';
import { conversationId,requireAuth,requireConversation,uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError,json,parseBody } from '../http/response';

const conversationSchema = v.object({ id: uuidSchema, title: v.pipe(v.string(), v.maxLength(80)) });

const conversationPatchSchema = v.object({ title: v.optional(v.pipe(v.string(), v.maxLength(80))), pinned: v.optional(v.boolean()), archived: v.optional(v.boolean()) });

export function registerLibraryRoutes(app: ApiRouter) {
app.get('/conversations', async (context) => {
  await requireAuth(context);
  const after = Number(context.req.query('after') ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '对话同步游标无效。');
  return json(await context.env.LIBRARY.getByName('personal').indexSnapshot(after));
});

app.post('/conversations', async (context) => {
  await requireAuth(context);
  const { id, title } = await parseBody(context, conversationSchema);
  if (!title.trim()) throw new HttpError(400, '对话 ID 或标题无效。');
  const library = context.env.LIBRARY.getByName('personal');
  const result = await library.create(id, title.trim());
  if ('error' in result) return json({ error: result.error }, result.status);
  return json(result, 201);
});

app.get('/conversations/:id', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  await requireConversation(context, id);
  return context.env.CONVERSATIONS.getByName(id).snapshotResponse();
});

app.patch('/conversations/:id', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  const patch = await parseBody(context, conversationPatchSchema);
  if (!Object.keys(patch).length) throw new HttpError(400, '请选择要修改的对话信息。');
  if (patch.title !== undefined) {
    patch.title = patch.title.trim();
    if (!patch.title) throw new HttpError(400, '标题应为 1 到 80 字。');
  }
  const result = await context.env.LIBRARY.getByName('personal').update(id, patch);
  if ('error' in result) return json({ error: result.error }, result.status);
  return json(result);
});

app.delete('/conversations/:id', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  const library = context.env.LIBRARY.getByName('personal');
  const deletion = await library.beginDelete(id);
  if (!deletion.completed) {
    await context.env.CONVERSATIONS.getByName(id).deleteConversation(deletion.deletedAt);
    await library.completeDelete(id);
  }
  return json({ deletedAt: deletion.deletedAt });
});
}
