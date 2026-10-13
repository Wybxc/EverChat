import { Hono } from 'hono';
import * as v from 'valibot';
import type { Env } from './env';
import type { SubmitInput } from '../shared/types';
import { authenticated, logoutCookie, passwordMatches, sessionCookie } from './auth';
import { HttpError, json, parseBody, type AppContext } from './http';
import { providerSettingsSchema } from './provider-config';
import { chatModels } from '../shared/models';
import { ProviderModelError, fetchProviderModels } from './provider-models';
import { storageErrorMessage } from './resource-limits';

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
  retryOf: v.optional(uuidSchema),
  revisionOf: v.optional(uuidSchema),
  selection: v.optional(v.object({ providerId: uuidSchema, model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) })),
  showReasoning: v.optional(v.boolean()),
  reasoningEffort: v.optional(v.picklist(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])),
});
const cancelSchema = v.object({ runId: uuidSchema });
const titleSchema = v.object({ title: v.pipe(v.string(), v.maxLength(80)) });

const requireAuth = async (context: AppContext) => {
  if (!await authenticated(context.req.raw, context.env)) throw new HttpError(401, '请先登录你的私人空间。');
};

const conversationId = (context: AppContext) => {
  const id = context.req.param('id');
  if (!id || !v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到这个接口。');
  return id;
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
  const config = signedIn ? await context.env.LIBRARY.getByName('personal').providerConfig() : null;
  const settings = signedIn ? await context.env.LIBRARY.getByName('personal').providerSettings() : null;
  return json({
    authenticated: signedIn,
    configured: Boolean(context.env.APP_PASSWORD && context.env.SESSION_SECRET),
    provider: config?.provider ?? '',
    model: config?.model ?? '',
    modelName: config?.modelName ?? '',
    activeProviderId: config?.providerId ?? null,
    models: settings ? chatModels(settings) : [],
    showReasoning: settings?.showReasoning ?? false,
    systemPrompt: settings?.systemPrompt ?? '', maxOutputTokens: settings?.maxOutputTokens ?? null,
  });
});

app.get('/settings/providers', async (context) => {
  await requireAuth(context);
  return json(await context.env.LIBRARY.getByName('personal').providerSettings());
});

app.put('/settings/providers', async (context) => {
  await requireAuth(context);
  const input = await parseBody(context, providerSettingsSchema);
  const normalizedInput = { ...input, showReasoning: input.showReasoning ?? false };
  const result = await context.env.LIBRARY.getByName('personal').saveProviderSettings(normalizedInput);
  if ('error' in result) throw new HttpError(400, result.error);
  return json(result.settings);
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
  return json(await context.env.LIBRARY.getByName('personal').list());
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
  const library = context.env.LIBRARY.getByName('personal');
  if (!await library.get(id)) throw new HttpError(404, '找不到这个对话。');
  return context.env.CONVERSATIONS.getByName(id).snapshotResponse();
});

app.get('/conversations/:id/measurements', async (context) => {
  if (context.env.GENERATION_METRICS !== '1') throw new HttpError(404, '找不到这个接口。');
  await requireAuth(context);
  const id = conversationId(context);
  if (!await context.env.LIBRARY.getByName('personal').get(id)) throw new HttpError(404, '找不到这个对话。');
  return json(await context.env.CONVERSATIONS.getByName(id).generationMeasurements());
});

app.get('/conversations/:id/sync', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  const library = context.env.LIBRARY.getByName('personal');
  if (!await library.get(id)) throw new HttpError(404, '找不到这个对话。');
  const token = context.req.header('Cookie')?.match(/everchat_session=(\d+)/)?.[1] ?? '0';
  const headers = new Headers(context.req.raw.headers);
  headers.set('X-Session-Expires', token);
  return context.env.CONVERSATIONS.getByName(id).fetch(new Request(context.req.raw, { headers }));
});

app.post('/conversations/:id/messages', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  const library = context.env.LIBRARY.getByName('personal');
  if (!await library.get(id)) throw new HttpError(404, '找不到这个对话。');
  const input = await parseBody(context, submitSchema) as SubmitInput;
  if (input.retryOf && (input.content !== undefined || input.revisionOf !== undefined)) throw new HttpError(400, '消息参数无效。');
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

app.post('/conversations/:id/cancel', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  const library = context.env.LIBRARY.getByName('personal');
  if (!await library.get(id)) throw new HttpError(404, '找不到这个对话。');
  const { runId } = await parseBody(context, cancelSchema);
  await context.env.CONVERSATIONS.getByName(id).cancel(runId);
  return json({ ok: true });
});

app.patch('/conversations/:id/title', async (context) => {
  await requireAuth(context);
  const id = conversationId(context);
  const library = context.env.LIBRARY.getByName('personal');
  if (!await library.get(id)) throw new HttpError(404, '找不到这个对话。');
  const { title } = await parseBody(context, titleSchema);
  if (!title.trim()) throw new HttpError(400, '标题应为 1 到 80 字。');
  await library.rename(id, title.trim());
  return json({ ok: true });
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
