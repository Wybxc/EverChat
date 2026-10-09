import type { Env } from './env';
import type { SubmitInput } from '../shared/types';
import { authenticated, logoutCookie, passwordMatches, sessionCookie } from './auth';
import { HttpError, json, readJson, validId } from './http';
export { Conversation } from './conversation';
export { Library } from './library';
export { GenerationWorkflow } from './workflow';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const mutation = !['GET', 'HEAD'].includes(request.method);
      const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
      if ((mutation || upgrade) && request.headers.get('Origin') !== url.origin) throw new HttpError(403, '此请求来源不受信任。');
      const library = env.LIBRARY.getByName('personal');
      if (url.pathname === '/api/session' && request.method === 'GET') {
        return json({ authenticated: await authenticated(request, env), configured: Boolean(env.APP_PASSWORD && env.SESSION_SECRET), provider: env.AI_PROVIDER, model: env.AI_PROVIDER === 'demo' ? '演示模型' : env.AI_MODEL });
      }
      if (url.pathname === '/api/login' && request.method === 'POST') {
        if (!env.APP_PASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(503, '请先在服务端配置 APP_PASSWORD 和至少 32 字符的 SESSION_SECRET。');
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
        if (!await library.allowLogin(ip)) throw new HttpError(429, '尝试次数过多，请 15 分钟后再试。');
        const { password } = await readJson<{ password: string }>(request);
        if (typeof password !== 'string' || password.length > 1024 || !await passwordMatches(password, env.APP_PASSWORD)) throw new HttpError(401, '访问密码不正确。');
        await library.clearLogin(ip);
        return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(request, env.SESSION_SECRET) });
      }
      if (!await authenticated(request, env)) throw new HttpError(401, '请先登录你的私人空间。');
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        // The browser closes its own live socket. Other devices retain their sessions.
        return json({ ok: true }, 200, { 'Set-Cookie': logoutCookie(request) });
      }
      if (url.pathname === '/api/conversations') {
        if (request.method === 'GET') return json(await library.list());
        if (request.method === 'POST') {
          const { id, title } = await readJson<{ id: string; title: string }>(request);
          if (!validId(id) || typeof title !== 'string' || !title.trim() || title.length > 80) throw new HttpError(400, '对话 ID 或标题无效。');
          if ((await library.list()).length >= 500 && !await library.get(id)) throw new HttpError(400, '原型最多保存 500 个对话。');
          return json(await library.create(id, title.trim()), 201);
        }
      }
      const route = url.pathname.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|sync|cancel|title))?$/);
      if (!route || !validId(route[1])) throw new HttpError(404, '找不到这个接口。');
      const [, id, action] = route;
      if (!await library.get(id)) throw new HttpError(404, '找不到这个对话。');
      const conversation = env.CONVERSATIONS.getByName(id);
      if (!action && request.method === 'GET') return json(await conversation.snapshot());
      if (action === 'sync' && request.method === 'GET') {
        const token = request.headers.get('Cookie')?.match(/everchat_session=(\d+)/)?.[1] ?? '0';
        const headers = new Headers(request.headers);
        headers.set('X-Session-Expires', token);
        return conversation.fetch(new Request(request, { headers }));
      }
      if (action === 'messages' && request.method === 'POST') {
        const input = await readJson<SubmitInput>(request);
        if (!validId(input.requestId) || (input.retryOf !== undefined && !validId(input.retryOf)) || (input.revisionOf !== undefined && !validId(input.revisionOf)) ||
            (input.content !== undefined && typeof input.content !== 'string') || (input.retryOf && (input.content !== undefined || input.revisionOf))) throw new HttpError(400, '消息参数无效。');
        const result = await conversation.submit(id, input);
        if ('error' in result) return json({ error: result.error }, result.status);
        await library.touch(id);
        return json(result, 202);
      }
      if (action === 'cancel' && request.method === 'POST') {
        const { runId } = await readJson<{ runId: string }>(request);
        if (!validId(runId)) throw new HttpError(400, '任务 ID 无效。');
        await conversation.cancel(runId);
        return json({ ok: true });
      }
      if (action === 'title' && request.method === 'PATCH') {
        const { title } = await readJson<{ title: string }>(request);
        if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new HttpError(400, '标题应为 1 到 80 字。');
        await library.rename(id, title.trim());
        return json({ ok: true });
      }
      throw new HttpError(405, '此接口不支持该操作。');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('EverChat request failed', error instanceof Error ? error.name : 'UnknownError');
      return json({ error: '服务暂时不可用，请稍后重试。' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
