import * as v from 'valibot';
import { requireAuth } from './access';
import type { ApiRouter } from './app';
import { authenticated, logoutCookie, passwordMatches, sessionCookie } from './auth';
import { HttpError, json, parseBody } from './response';

const loginSchema = v.object({ password: v.pipe(v.string(), v.maxLength(1024)) });

export function registerSessionRoutes(app: ApiRouter) {
  app.get('/session', async (context) => {
    const signedIn = await authenticated(context.req.raw, context.env);
    if (signedIn) return context.env.LIBRARY.getByName('personal').sessionResponse();
    return json({
      authenticated: signedIn,
      configured: Boolean(context.env.APP_PASSWORD && context.env.SESSION_SECRET),
      attachmentsConfigured: Boolean(context.env.ATTACHMENTS),
      provider: '',
      model: '',
      modelName: '',
      activeProviderId: null,
      models: [],
      showReasoning: false,
      systemPrompt: '',
      maxOutputTokens: null,
    });
  });

  app.post('/login', async (context) => {
    const { APP_PASSWORD, SESSION_SECRET } = context.env;
    if (!APP_PASSWORD || !SESSION_SECRET || SESSION_SECRET.length < 32)
      throw new HttpError(503, '请先在服务端配置 APP_PASSWORD 和至少 32 字符的 SESSION_SECRET。');
    const library = context.env.LIBRARY.getByName('personal');
    const ip = context.req.header('CF-Connecting-IP') ?? 'local';
    if (!(await library.allowLogin(ip)))
      throw new HttpError(429, '尝试次数过多，请 15 分钟后再试。');
    const { password } = await parseBody(context, loginSchema);
    if (!(await passwordMatches(password, APP_PASSWORD)))
      throw new HttpError(401, '访问密码不正确。');
    await library.clearLogin(ip);
    return json({ ok: true }, 200, {
      'Set-Cookie': await sessionCookie(context.req.raw, SESSION_SECRET),
    });
  });

  app.post('/logout', async (context) => {
    await requireAuth(context);
    return json({ ok: true }, 200, { 'Set-Cookie': logoutCookie(context.req.raw) });
  });
}
