import * as v from 'valibot';
import { modelProbeInputSchema } from '../../shared/models/probe';
import { requireAuth, uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, json, parseBody } from '../http/response';
import { ProviderModelError, fetchProviderModels } from './models';
import { probeModelCapability } from './probe';

export function registerProvidersRoutes(app: ApiRouter) {
  app.get('/settings/providers', async (context) => {
    await requireAuth(context);
    return context.env.LIBRARY.getByName('personal').providerSettingsResponse();
  });

  app.put('/settings/providers', async (context) => {
    await requireAuth(context);
    if (!context.req.header('Content-Type')?.includes('application/json'))
      throw new HttpError(415, '请使用 JSON 请求。');
    if (!context.req.raw.body) throw new HttpError(400, '请求内容为空。');
    return context.env.LIBRARY.getByName('personal').saveProviderSettingsResponse(
      context.req.raw.body,
    );
  });

  app.get('/settings/providers/:id/models', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id');
    if (!v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到这个供应商。');
    const profile = await context.env.LIBRARY.getByName('personal').providerForModelList(id);
    if (!profile) throw new HttpError(404, '找不到这个供应商。');
    try {
      return json({ models: await fetchProviderModels(profile) });
    } catch (error) {
      if (error instanceof ProviderModelError)
        return json(
          { error: error.message, code: 'PROVIDER_ERROR', failure: error.details },
          error.status,
        );
      throw new HttpError(502, '获取模型列表失败。');
    }
  });

  app.post('/settings/providers/:id/models/test', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id');
    if (!v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到这个供应商。');
    const input = await parseBody(context, modelProbeInputSchema, {
      maxBytes: 2048,
      tooLarge: '测试请求过大。',
    });
    const profile = await context.env.LIBRARY.getByName('personal').providerForModelList(id);
    if (!profile || !profile.models.some((model) => model.id === input.model))
      throw new HttpError(404, '找不到这个模型。');
    if (!profile.apiKey) throw new HttpError(400, '请先配置 API 密钥。');
    return json(
      await probeModelCapability(
        { ...profile, model: input.model, systemPrompt: '', maxOutputTokens: null },
        input.capability,
        context.req.raw.signal,
      ),
    );
  });
}
