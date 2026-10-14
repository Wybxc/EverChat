import { Hono } from 'hono';
import * as v from 'valibot';
import type { Env } from './env';
import type { SubmitInput } from '../shared/types';
import { authenticated, logoutCookie, passwordMatches, sessionCookie } from './auth';
import { HttpError, json, jsonWithStream, parseBody, type AppContext } from './http';
import { ARCHIVE_FORMAT, ARCHIVE_VERSION } from '../shared/archive';
import type { ImportResult } from './archive-imports';
import { ProviderModelError, fetchProviderModels } from './provider-models';
import { storageErrorMessage } from './resource-limits';
import { SEARCH_QUERY_LIMIT } from '../shared/search';
import { conversationSettingsSchema } from '../shared/conversation-settings';
import { promptPresetInputSchema } from '../shared/prompt-presets';
import { MAX_MESSAGE_DOCUMENTS } from '../shared/documents';
import { pdfExtractionSchema } from '../shared/pdf';
import { MAX_MESSAGE_IMAGES } from '../shared/images';
import { messageAttachments } from '../shared/message-content';
import { attachmentInputSchema } from '../shared/attachments';

export { Conversation } from './conversation';
export { Library } from './library';

type AppEnv = { Bindings: Env };
const app = new Hono<AppEnv>().basePath('/api');
const uuidSchema = v.pipe(v.string(), v.uuid());
const loginSchema = v.object({ password: v.pipe(v.string(), v.maxLength(1024)) });
const conversationSchema = v.object({ id: uuidSchema, title: v.pipe(v.string(), v.maxLength(80)) });
const submitSchema = v.object({
  requestId: uuidSchema,
  content: v.optional(v.string()),
  fileIds: v.optional(v.pipe(v.array(uuidSchema), v.maxLength(MAX_MESSAGE_DOCUMENTS), v.check((ids) => new Set(ids).size === ids.length))),
  imageIds: v.optional(v.pipe(v.array(uuidSchema), v.maxLength(MAX_MESSAGE_IMAGES), v.check((ids) => new Set(ids).size === ids.length))),
  retryOf: v.optional(uuidSchema),
  revisionOf: v.optional(uuidSchema),
  branchHead: v.optional(uuidSchema),
  summaryThrough: v.optional(uuidSchema),
  selection: v.optional(v.object({ providerId: uuidSchema, model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) })),
  showReasoning: v.optional(v.boolean()),
  reasoningEffort: v.optional(v.picklist(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])),
  settings: v.optional(conversationSettingsSchema),
});
const cancelSchema = v.object({ runId: uuidSchema });
const conversationPatchSchema = v.object({ title: v.optional(v.pipe(v.string(), v.maxLength(80))), pinned: v.optional(v.boolean()), archived: v.optional(v.boolean()) });
const assistantEditSchema = v.object({ requestId: uuidSchema, content: v.pipe(v.string(), v.maxLength(100_000)) });

const requireAuth = async (context: AppContext) => {
  if (!await authenticated(context.req.raw, context.env)) throw new HttpError(401, '请先登录你的私人空间。');
};

const conversationId = (context: AppContext) => {
  const id = context.req.param('id');
  if (!id || !v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到这个接口。');
  return id;
};
const requireConversation = async (context: AppContext, id: string) => {
  const library = context.env.LIBRARY.getByName('personal');
  if (!await library.get(id)) {
    if (await library.deletedAt(id)) throw new HttpError(410, '这个对话已删除。');
    throw new HttpError(404, '找不到这个对话。');
  }
  return library;
};

app.use('*', async (context, next) => {
  const request = context.req.raw;
  const url = new URL(request.url);
  const mutation = !['GET', 'HEAD'].includes(request.method);
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  if ((mutation || upgrade) && request.headers.get('Origin') !== url.origin) throw new HttpError(403, '此请求来源不受信任。');
  await next();
});

app.get('/session', async (context) => {
  const signedIn = await authenticated(context.req.raw, context.env);
  if (signedIn) return context.env.LIBRARY.getByName('personal').sessionResponse();
  return json({
    authenticated: signedIn,
    configured: Boolean(context.env.APP_PASSWORD && context.env.SESSION_SECRET),
    attachmentsConfigured: Boolean(context.env.ATTACHMENTS),
    provider: '', model: '', modelName: '', activeProviderId: null, models: [],
    showReasoning: false, systemPrompt: '', maxOutputTokens: null,
  });
});

app.get('/settings/providers', async (context) => {
  await requireAuth(context);
  return context.env.LIBRARY.getByName('personal').providerSettingsResponse();
});

app.get('/settings/presets', async (context) => {
  await requireAuth(context);
  return json(await context.env.LIBRARY.getByName('personal').promptPresets());
});
app.put('/settings/presets/:id', async (context) => {
  await requireAuth(context);
  const id = context.req.param('id');
  if (!v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到这个预设。');
  const input = await parseBody(context, promptPresetInputSchema, { maxBytes: 160_000, tooLarge: '提示词预设太长。' });
  const result = await context.env.LIBRARY.getByName('personal').savePromptPreset(id, input);
  if ('error' in result) throw new HttpError(result.status, result.error);
  return json(result);
});
app.delete('/settings/presets/:id', async (context) => {
  await requireAuth(context);
  const id = context.req.param('id');
  if (!v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到这个预设。');
  return json(await context.env.LIBRARY.getByName('personal').deletePromptPreset(id));
});

app.put('/settings/providers', async (context) => {
  await requireAuth(context);
  if (!context.req.header('Content-Type')?.includes('application/json')) throw new HttpError(415, '请使用 JSON 请求。');
  if (!context.req.raw.body) throw new HttpError(400, '请求内容为空。');
  return context.env.LIBRARY.getByName('personal').saveProviderSettingsResponse(context.req.raw.body);
});

app.get('/settings/providers/:id/models', async (context) => {
  await requireAuth(context);
  const id = context.req.param('id');
  if (!v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到这个供应商。');
  const profile = await context.env.LIBRARY.getByName('personal').providerForModelList(id);
  if (!profile) throw new HttpError(404, '找不到这个供应商。');
  try { return json({ models: await fetchProviderModels(profile) }); }
  catch (error) {
    if (error instanceof ProviderModelError) throw new HttpError(error.status, error.message);
    throw new HttpError(502, '获取模型列表失败。');
  }
});

app.post('/login', async (context) => {
  const { APP_PASSWORD, SESSION_SECRET } = context.env;
  if (!APP_PASSWORD || !SESSION_SECRET || SESSION_SECRET.length < 32) throw new HttpError(503, '请先在服务端配置 APP_PASSWORD 和至少 32 字符的 SESSION_SECRET。');
  const library = context.env.LIBRARY.getByName('personal');
  const ip = context.req.header('CF-Connecting-IP') ?? 'local';
  if (!await library.allowLogin(ip)) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试。');
  const { password } = await parseBody(context, loginSchema);
  if (!await passwordMatches(password, APP_PASSWORD)) throw new HttpError(401, '访问密码不正确。');
  await library.clearLogin(ip);
  return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(context.req.raw, SESSION_SECRET) });
});

app.post('/logout', async (context) => {
  await requireAuth(context);
  return json({ ok: true }, 200, { 'Set-Cookie': logoutCookie(context.req.raw) });
});

app.get('/conversations', async (context) => {
  await requireAuth(context);
  const after = Number(context.req.query('after') ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '对话同步游标无效。');
  return json(await context.env.LIBRARY.getByName('personal').indexSnapshot(after));
});

app.get('/search', async (context) => {
  await requireAuth(context);
  const query = context.req.query('q')?.trim() ?? '', cursor = context.req.query('cursor');
  const archived = context.req.query('archived') ?? 'false';
  if (!query || query.length > SEARCH_QUERY_LIMIT || cursor && cursor.length > 4096 || !['true', 'false'].includes(archived)) throw new HttpError(400, '搜索参数无效。');
  const result = await context.env.LIBRARY.getByName('personal').search(query, archived === 'true', cursor);
  if ('status' in result) return json({ error: result.error }, result.status);
  return json(result);
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

app.put('/conversations/:id/settings', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  await requireConversation(context, id);
  const settings = await parseBody(context, conversationSettingsSchema, { maxBytes: 160_000, tooLarge: '会话参数太长。' });
  const result = await context.env.CONVERSATIONS.getByName(id).saveSettings(id, settings);
  if ('error' in result) return json({ error: result.error }, result.status);
  return json(result);
});

async function duplicateConversation(context: AppContext, messageId?: string) {
  await requireAuth(context);
  const id = conversationId(context);
  if (messageId !== undefined && !v.safeParse(uuidSchema, messageId).success) throw new HttpError(404, '找不到这条消息。');
  const { requestId } = await parseBody(context, v.strictObject({ requestId: uuidSchema }));
  const library = context.env.LIBRARY.getByName('personal');
  const result = await library.duplicate(id, requestId, messageId);
  if ('error' in result) return json({ error: result.error, ...(await library.copyStopped(requestId) ? { code: 'copy-stopped' } : {}) }, result.status);
  return jsonWithStream({ id: result.id, conversation: await library.get(result.id) }, 'snapshot', await context.env.CONVERSATIONS.getByName(result.id).snapshotResponse(), 201);
}
app.post('/conversations/:id/duplicate', (context) => duplicateConversation(context));
app.post('/conversations/:id/messages/:messageId/duplicate', (context) => duplicateConversation(context, context.req.param('messageId')));

app.post('/backup/restore', async (context) => {
  await requireAuth(context);
  const library = context.env.LIBRARY.getByName('personal');
  const id = crypto.randomUUID();
  const wrapped = jsonWithStream({ format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, files: [] }, 'backup', new Response(importBody(context, true)));
  return importResponse(context, id, await library.beginImport(id, wrapped.body!), true);
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

const attachmentId = (context: AppContext) => {
  const id = context.req.param('attachmentId');
  if (!id || !v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到附件。');
  return id;
};
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

app.post('/conversations/:id/messages', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  const library = await requireConversation(context, id);
  const input = await parseBody(context, submitSchema, { maxBytes: 240_000, tooLarge: '消息或会话参数太长。' }) as SubmitInput;
  if (input.summaryThrough && (input.content !== undefined || input.retryOf || input.revisionOf || input.branchHead || input.settings || input.reasoningEffort || input.showReasoning !== undefined || input.imageIds !== undefined || input.fileIds !== undefined)) throw new HttpError(400, '摘要请求不能同时指定聊天内容或会话参数。');
  if (input.retryOf && (input.content !== undefined || input.revisionOf !== undefined || input.imageIds !== undefined || input.fileIds !== undefined)) throw new HttpError(400, '消息参数无效。');
  if (input.branchHead && input.revisionOf) throw new HttpError(400, '编辑消息不能同时指定分支。');
  if (input.branchHead && input.retryOf && input.branchHead !== input.retryOf) throw new HttpError(400, '重新生成的分支必须对应原回答。');
  const baseConfig = await library.providerConfig(input.selection);
  if (!baseConfig) {
    const result = await context.env.CONVERSATIONS.getByName(id).submit(id, input, null);
    if ('error' in result) return json({ error: result.error }, result.status);
    await library.touch(id);
    return json(result, 202);
  }
  const config = input.reasoningEffort ? await library.providerConfig(input.selection, input.reasoningEffort) : baseConfig;
  if (!config) throw new HttpError(400, '所选模型不支持此思维强度。');
  if (config) config.showReasoning = input.showReasoning ?? false;
  const result = await context.env.CONVERSATIONS.getByName(id).submit(id, input, config);
  if ('error' in result) return json({ error: result.error }, result.status);
  await library.touch(id);
  return json(result, 202);
});

app.patch('/conversations/:id/messages/:messageId', async (context) => {
  await requireAuth(context);
  const id = conversationId(context), messageId = context.req.param('messageId');
  if (!v.safeParse(uuidSchema, messageId).success) throw new HttpError(404, '找不到这条消息。');
  const library = await requireConversation(context, id);
  const input = await parseBody(context, assistantEditSchema, { maxBytes: 640_000, tooLarge: '回答太长，请控制在 100,000 字以内。' });
  const result = await context.env.CONVERSATIONS.getByName(id).reviseAssistant(id, messageId, input.requestId, input.content);
  if ('error' in result) return json({ error: result.error }, result.status);
  await library.touch(id);
  return json(result, 201);
});

app.delete('/conversations/:id/messages/:messageId', async (context) => {
  await requireAuth(context);
  const id = conversationId(context), messageId = context.req.param('messageId');
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

app.notFound(() => json({ error: '找不到这个接口。' }, 404));
app.onError((error) => {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  const storage = storageErrorMessage(error);
  if (storage) return json({ error: storage }, 507);
  console.error('EverChat request failed', error instanceof Error ? error.name : 'UnknownError');
  return json({ error: '服务暂时不可用，请稍后重试。' }, 500);
});

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    return app.fetch(request, env, context);
  },
} satisfies ExportedHandler<Env>;
