import * as v from 'valibot';
import { attachmentInputSchema } from '../../shared/attachments/files';
import { pdfExtractionSchema } from '../../shared/attachments/pdf';
import { conversationId,requireAuth,requireConversation,uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError,json,parseBody,type AppContext } from '../http/response';

const attachmentId = (context: AppContext) => {
  const id = context.req.param('attachmentId');
  if (!id || !v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到附件。');
  return id;
};

export function registerAttachmentsRoutes(app: ApiRouter) {
app.get('/conversations/:id/attachments', async (context) => {
  await requireAuth(context); const id = conversationId(context), library = await requireConversation(context, id);
  const result = await library.listAttachments(id);
  return 'error' in result ? json({ error: result.error }, result.status) : json(result.value);
});

app.post('/conversations/:id/attachments', async (context) => {
  await requireAuth(context); const id = conversationId(context), library = await requireConversation(context, id);
  const input = await parseBody(context, attachmentInputSchema, { maxBytes: 2000 });
  const result = await library.registerAttachment(id, input);
  return 'error' in result ? json({ error: result.error }, result.status) : json(result.value, 201);
});

app.put('/conversations/:id/attachments/:attachmentId/content', async (context) => {
  await requireAuth(context); const id = conversationId(context), library = await requireConversation(context, id), fileId = attachmentId(context);
  if (!context.req.raw.body) throw new HttpError(400, '附件内容为空。');
  const result = await library.uploadAttachment(id, fileId, context.req.raw.body);
  return 'error' in result ? json({ error: result.error }, result.status) : json(result.value);
});

app.on(['GET', 'HEAD'], '/conversations/:id/attachments/:attachmentId/content', async (context) => {
  await requireAuth(context); const id = conversationId(context), library = await requireConversation(context, id);
  return library.attachmentResponse(id, attachmentId(context), context.req.method === 'HEAD');
});

app.post('/conversations/:id/attachments/:attachmentId/document', async (context) => {
  await requireAuth(context); const id = conversationId(context), library = await requireConversation(context, id);
  const input = context.req.header('Content-Type')?.includes('application/json') ? await parseBody(context, pdfExtractionSchema, { maxBytes: 264192, tooLarge: 'PDF 提取结果过大，请拆分文件。' }) : undefined;
  const result = await library.parseDocument(id, attachmentId(context), input);
  return 'error' in result ? json({ error: result.error }, result.status) : json(result.value);
});

app.get('/conversations/:id/attachments/:attachmentId/document', async (context) => {
  await requireAuth(context); const id = conversationId(context), library = await requireConversation(context, id);
  const result = await library.documentText(id, attachmentId(context));
  return 'error' in result ? json({ error: result.error }, result.status) : json(result.value);
});

app.delete('/conversations/:id/attachments/:attachmentId', async (context) => {
  await requireAuth(context); const id = conversationId(context), library = await requireConversation(context, id);
  const result = await library.removeAttachment(id, attachmentId(context));
  return 'error' in result ? json({ error: result.error }, result.status) : json({ ok: true });
});
}
