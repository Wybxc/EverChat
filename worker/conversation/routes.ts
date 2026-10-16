import * as v from 'valibot';
import { MAX_MESSAGE_DOCUMENTS } from '../../shared/attachments/documents';
import { MAX_MESSAGE_IMAGES } from '../../shared/attachments/images';
import { conversationSettingsSchema } from '../../shared/conversation/settings';
import type { SubmitInput } from '../../shared/conversation/types';
import { conversationId, requireAuth, requireConversation, uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, json, parseBody } from '../http/response';

const submitSchema = v.object({
  requestId: uuidSchema,
  content: v.optional(v.string()),
  fileIds: v.optional(
    v.pipe(
      v.array(uuidSchema),
      v.maxLength(MAX_MESSAGE_DOCUMENTS),
      v.check((ids) => new Set(ids).size === ids.length),
    ),
  ),
  imageIds: v.optional(
    v.pipe(
      v.array(uuidSchema),
      v.maxLength(MAX_MESSAGE_IMAGES),
      v.check((ids) => new Set(ids).size === ids.length),
    ),
  ),
  retryOf: v.optional(uuidSchema),
  revisionOf: v.optional(uuidSchema),
  parentId: v.optional(v.nullable(uuidSchema)),
  summaryThrough: v.optional(uuidSchema),
  selection: v.optional(
    v.object({
      providerId: uuidSchema,
      model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    }),
  ),
  showReasoning: v.optional(v.boolean()),
  reasoningEffort: v.optional(
    v.picklist(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  ),
  settings: v.optional(conversationSettingsSchema),
  tools: v.optional(
    v.pipe(
      v.array(v.picklist(['web_search', 'read_webpage'])),
      v.minLength(1),
      v.maxLength(2),
      v.check((names) => new Set(names).size === names.length),
    ),
  ),
});

const cancelSchema = v.object({ runId: uuidSchema });

const assistantEditSchema = v.object({
  requestId: uuidSchema,
  content: v.pipe(v.string(), v.maxLength(100_000)),
});

export function registerConversationRoutes(app: ApiRouter) {
  app.put('/conversations/:id/settings', async (context) => {
    await requireAuth(context);
    const id = conversationId(context);
    await requireConversation(context, id);
    const settings = await parseBody(context, conversationSettingsSchema, {
      maxBytes: 160_000,
      tooLarge: '会话参数太长。',
    });
    const result = await context.env.CONVERSATIONS.getByName(id).saveSettings(id, settings);
    if ('error' in result) return json({ error: result.error }, result.status);
    return json(result);
  });

  app.get('/conversations/:id/measurements', async (context) => {
    if (context.env.GENERATION_METRICS !== '1') throw new HttpError(404, '找不到这个接口。');
    await requireAuth(context);
    const id = conversationId(context);
    await requireConversation(context, id);
    return json(await context.env.CONVERSATIONS.getByName(id).generationMeasurements());
  });

  app.get('/conversations/:id/sync', async (context) => {
    await requireAuth(context);
    const id = conversationId(context);
    await requireConversation(context, id);
    const token = context.req.header('Cookie')?.match(/everchat_session=(\d+)/)?.[1] ?? '0';
    const headers = new Headers(context.req.raw.headers);
    headers.set('X-Session-Expires', token);
    return context.env.CONVERSATIONS.getByName(id).fetch(new Request(context.req.raw, { headers }));
  });

  app.post('/conversations/:id/messages', async (context) => {
    await requireAuth(context);
    const id = conversationId(context);
    const library = await requireConversation(context, id);
    const input = (await parseBody(context, submitSchema, {
      maxBytes: 240_000,
      tooLarge: '消息或会话参数太长。',
    })) as SubmitInput;
    if (
      input.summaryThrough &&
      (input.content !== undefined ||
        input.retryOf ||
        input.revisionOf ||
        input.parentId !== undefined ||
        input.settings ||
        input.reasoningEffort ||
        input.showReasoning !== undefined ||
        input.imageIds !== undefined ||
        input.fileIds !== undefined ||
        input.tools !== undefined)
    )
      throw new HttpError(400, '摘要请求不能同时指定聊天内容或会话参数。');
    if (
      input.retryOf &&
      (input.content !== undefined ||
        input.revisionOf !== undefined ||
        input.imageIds !== undefined ||
        input.fileIds !== undefined)
    )
      throw new HttpError(400, '消息参数无效。');
    if (input.parentId !== undefined && (input.revisionOf || input.retryOf))
      throw new HttpError(400, '修订或重新生成不能同时指定父消息。');
    if (
      !input.summaryThrough &&
      !input.revisionOf &&
      !input.retryOf &&
      input.parentId === undefined
    )
      throw new HttpError(400, '发送消息必须指定父消息。');
    const baseConfig = await library.providerConfig(input.selection);
    if (!baseConfig) {
      const result = await context.env.CONVERSATIONS.getByName(id).submit(id, input, null);
      if ('error' in result) return json({ error: result.error }, result.status);
      await library.touch(id);
      return json(result, 202);
    }
    const config = input.reasoningEffort
      ? await library.providerConfig(input.selection, input.reasoningEffort)
      : baseConfig;
    if (!config) throw new HttpError(400, '所选模型不支持此思维强度。');
    if (input.tools) config.webTools = await library.webToolConfig();
    if (config) config.showReasoning = input.showReasoning ?? false;
    const result = await context.env.CONVERSATIONS.getByName(id).submit(id, input, config);
    if ('error' in result) return json({ error: result.error }, result.status);
    await library.touch(id);
    return json(result, 202);
  });

  app.patch('/conversations/:id/messages/:messageId', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      messageId = context.req.param('messageId');
    if (!v.safeParse(uuidSchema, messageId).success) throw new HttpError(404, '找不到这条消息。');
    const library = await requireConversation(context, id);
    const input = await parseBody(context, assistantEditSchema, {
      maxBytes: 640_000,
      tooLarge: '回答太长，请控制在 100,000 字以内。',
    });
    const result = await context.env.CONVERSATIONS.getByName(id).reviseAssistant(
      id,
      messageId,
      input.requestId,
      input.content,
    );
    if ('error' in result) return json({ error: result.error }, result.status);
    await library.touch(id);
    return json(result, 201);
  });

  app.delete('/conversations/:id/messages/:messageId', async (context) => {
    await requireAuth(context);
    const id = conversationId(context),
      messageId = context.req.param('messageId');
    if (!v.safeParse(uuidSchema, messageId).success) throw new HttpError(404, '找不到这条消息。');
    await requireConversation(context, id);
    const result = await context.env.CONVERSATIONS.getByName(id).deleteMessage(id, messageId);
    if ('error' in result) return json({ error: result.error }, result.status);
    return json(result);
  });

  app.post('/conversations/:id/cancel', async (context) => {
    await requireAuth(context);
    const id = conversationId(context);
    await requireConversation(context, id);
    const { runId } = await parseBody(context, cancelSchema);
    await context.env.CONVERSATIONS.getByName(id).cancel(runId);
    return json({ ok: true });
  });
}
