import * as v from 'valibot';
import { ARCHIVE_FORMAT,ARCHIVE_VERSION } from '../../shared/backup/archive';
import { conversationId,requireAuth,requireConversation,uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError,json,jsonWithStream,parseBody,type AppContext } from '../http/response';
import type { ImportResult } from './imports';

const importBody = (context: AppContext, jsonBody: boolean) => {
  if (jsonBody && !context.req.header('Content-Type')?.includes('application/json')) throw new HttpError(415, '请使用 JSON 清单。');
  if (!context.req.raw.body) throw new HttpError(400, '请求内容为空。');
  return context.req.raw.body;
};

async function importResponse(context: AppContext, id: string, result: ImportResult, snapshot = false) {
  const library = context.env.LIBRARY.getByName('personal');
  if ('error' in result) return json({ error: result.error, ...(await library.importStopped(id) ? { code: 'import-stopped' } : {}) }, result.status);
  if (!snapshot || result.status !== 'completed') return json(result, 200);
  return jsonWithStream({ id: result.id, conversation: await library.get(result.id) }, 'snapshot', await context.env.CONVERSATIONS.getByName(result.id).snapshotResponse(), 201);
}

async function duplicateConversation(context: AppContext, messageId?: string) {
  await requireAuth(context);
  const id = conversationId(context);
  if (messageId !== undefined && !v.safeParse(uuidSchema, messageId).success) throw new HttpError(404, '找不到这条消息。');
  const { requestId, viewHeadId } = await parseBody(context, v.strictObject({ requestId: uuidSchema, viewHeadId: v.optional(uuidSchema) }));
  const library = context.env.LIBRARY.getByName('personal');
  const result = await library.duplicate(id, requestId, messageId, viewHeadId);
  if ('error' in result) return json({ error: result.error, ...(await library.copyStopped(requestId) ? { code: 'copy-stopped' } : {}) }, result.status);
  return jsonWithStream({ id: result.id, viewHeadId: result.viewHeadId, conversation: await library.get(result.id) }, 'snapshot', await context.env.CONVERSATIONS.getByName(result.id).snapshotResponse(), 201);
}

export function registerBackupRoutes(app: ApiRouter) {
app.get('/conversations/:id/backup', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  await requireConversation(context, id);
  return context.env.LIBRARY.getByName('personal').archiveManifestResponse(id, true);
});

app.get('/conversations/:id/backup/manifest', async (context) => {
  await requireAuth(context); const id = conversationId(context);
  await requireConversation(context, id);
  return context.env.LIBRARY.getByName('personal').archiveManifestResponse(id);
});

app.post('/backup/imports/:id', async (context) => {
  await requireAuth(context); const id = conversationId(context);
  return importResponse(context, id, await context.env.LIBRARY.getByName('personal').beginImport(id, importBody(context, true)));
});

app.get('/backup/imports/:id', async (context) => {
  await requireAuth(context); const id = conversationId(context);
  return importResponse(context, id, await context.env.LIBRARY.getByName('personal').importStatus(id));
});

app.post('/backup/imports/:id/complete', async (context) => {
  await requireAuth(context); const id = conversationId(context);
  return importResponse(context, id, await context.env.LIBRARY.getByName('personal').finishImport(id), true);
});

app.delete('/backup/imports/:id', async (context) => {
  await requireAuth(context); const result = await context.env.LIBRARY.getByName('personal').cancelImport(conversationId(context));
  return 'error' in result ? json({ error: result.error }, result.status) : json({ cancelled: true });
});

app.put('/backup/imports/:id/files/:sourceId/:kind', async (context) => {
  await requireAuth(context); const id = conversationId(context), sourceId = context.req.param('sourceId'), kind = context.req.param('kind');
  if (!v.safeParse(uuidSchema, sourceId).success || !['content', 'text'].includes(kind)) throw new HttpError(404, '找不到存档中的文件。');
  const result = await context.env.LIBRARY.getByName('personal').uploadImportFile(id, sourceId, importBody(context, false), kind === 'text');
  return 'error' in result ? json({ error: result.error, ...(await context.env.LIBRARY.getByName('personal').importStopped(id) ? { code: 'import-stopped' } : {}) }, result.status) : json(result.value);
});

app.post('/conversations/:id/duplicate', (context) => duplicateConversation(context));

app.post('/conversations/:id/messages/:messageId/duplicate', (context) => duplicateConversation(context, context.req.param('messageId')));

app.post('/backup/restore', async (context) => {
  await requireAuth(context);
  const library = context.env.LIBRARY.getByName('personal');
  const id = crypto.randomUUID();
  const wrapped = jsonWithStream({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, files: [] }, 'backup', new Response(importBody(context, true)));
  return importResponse(context, id, await library.beginImport(id, wrapped.body!), true);
});
}
