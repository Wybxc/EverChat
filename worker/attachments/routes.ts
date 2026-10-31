import * as v from 'valibot';
import { documentRangesSchema } from '../../shared/attachments/documents';
import { attachmentUploadInputSchema } from '../../shared/attachments/files';
import { problem } from '../../shared/errors/descriptor';
import { conversationId, requireAuth, requireConversation, uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, json, parseBody, type AppContext } from '../http/response';

const attachmentId = (context: AppContext) => {
  const id = context.req.param('attachmentId');
  if (!id || !v.safeParse(uuidSchema, id).success)
    throw new HttpError(404, '找不到附件。', undefined, problem('NOT_FOUND'));
  return id;
};

export function registerAttachmentsRoutes(app: ApiRouter) {
  app.post('/conversations/:id/attachments/uploads', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      library = await requireConversation(context, id);
    const input = await parseBody(
      context,
      v.pipe(v.array(attachmentUploadInputSchema), v.minLength(1)),
    );
    const result = await library.prepareAttachmentUploads(id, input);
    return 'error' in result
      ? json({ error: result.error, issue: result.issue }, result.status)
      : json(result.value, 201);
  });
  app.post('/conversations/:id/attachments/:attachmentId/receive', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      library = await requireConversation(context, id);
    const result = await library.receiveAttachment(id, attachmentId(context));
    return 'error' in result
      ? json({ error: result.error, issue: result.issue }, result.status)
      : json(result.value);
  });
  app.get('/conversations/:id/attachments', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      library = await requireConversation(context, id);
    const result = await library.listAttachments(id);
    return 'error' in result
      ? json({ error: result.error, issue: result.issue }, result.status)
      : json(result.value);
  });

  app.on(
    ['GET', 'HEAD'],
    '/conversations/:id/attachments/:attachmentId/content',
    async (context) => {
      await requireAuth(context);
      const id = conversationId(context),
        library = await requireConversation(context, id);
      return library.attachmentResponse(id, attachmentId(context), context.req.method === 'HEAD');
    },
  );

  app.post('/conversations/:id/attachments/:attachmentId/document', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      library = await requireConversation(context, id);
    const type = context.req.header('Content-Type') ?? '';
    if (
      context.req.raw.body &&
      (type.includes('application/json') || type.includes('application/vnd.everchat.pdf-text'))
    )
      return library.parseDocumentBody(
        id,
        attachmentId(context),
        context.req.raw.body,
        type.includes('application/json') ? 'json' : 'text',
      );
    const result = await library.parseDocument(id, attachmentId(context));
    return 'error' in result
      ? json({ error: result.error, issue: result.issue }, result.status)
      : json(result.value);
  });

  app.get('/conversations/:id/attachments/:attachmentId/document', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      library = await requireConversation(context, id);
    return library.documentResponse(id, attachmentId(context));
  });

  app.get('/conversations/:id/attachments/:attachmentId/document/content', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      library = await requireConversation(context, id);
    return library.documentContentResponse(id, attachmentId(context));
  });
  app.get('/conversations/:id/attachments/:attachmentId/document/page', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      library = await requireConversation(context, id);
    const offset = Number(context.req.query('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, '无效文件位置。');
    return json(await library.documentPreviewPage(id, attachmentId(context), offset));
  });
  app.post('/conversations/:id/attachments/:attachmentId/document/selection', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      library = await requireConversation(context, id);
    const input = await parseBody(context, v.strictObject({ ranges: documentRangesSchema }));
    const result = await library.selectDocument(id, attachmentId(context), input.ranges);
    return 'error' in result
      ? json({ error: result.error, issue: result.issue }, result.status)
      : json(result.value);
  });

  app.delete('/conversations/:id/attachments/:attachmentId', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      library = await requireConversation(context, id);
    const result = await library.removeAttachment(id, attachmentId(context));
    return 'error' in result
      ? json({ error: result.error, issue: result.issue }, result.status)
      : json({ ok: true });
  });
}
