import * as v from 'valibot';
import { problem } from '../../shared/errors/descriptor';
import { modelProbeInputSchema } from '../../shared/models/probe';
import { requireAuth, uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, json, parseBody } from '../http/response';
import { serverToolCatalog, serverToolProbeKinds } from '../../shared/tools/server-tools';
import { providerToolStores } from './server-tool-stores';

export function registerProvidersRoutes(app: ApiRouter) {
  app.get('/settings/providers', async (context) => {
    await requireAuth(context);
    return context.env.LIBRARY.getByName('personal').providerSettingsResponse();
  });

  app.put('/settings/providers', async (context) => {
    await requireAuth(context);
    if (!context.req.header('Content-Type')?.includes('application/json'))
      throw new HttpError(415, '请使用 JSON 请求。', undefined, problem('PROVIDER_FAILED'));
    if (!context.req.raw.body)
      throw new HttpError(400, '请求内容为空。', undefined, problem('PROVIDER_FAILED'));
    return context.env.LIBRARY.getByName('personal').saveProviderSettingsResponse(
      context.req.raw.body,
    );
  });

  app.get('/settings/providers/:id/models', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id');
    if (!v.safeParse(uuidSchema, id).success)
      throw new HttpError(404, '找不到这个供应商。', undefined, problem('NOT_FOUND'));
    return context.env.LIBRARY.getByName('personal').providerModelsResponse(id);
  });

  app.get('/settings/providers/:id/server-tools', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id'),
      model = context.req.query('model');
    if (!v.is(uuidSchema, id) || (model?.length ?? 0) > 200)
      throw new HttpError(404, '找不到这个供应商。', undefined, problem('NOT_FOUND'));
    const profile = await context.env.LIBRARY.getByName('personal').providerForModelList(id, model);
    if (!profile) throw new HttpError(404, '找不到这个供应商。', undefined, problem('NOT_FOUND'));
    return json({
      models: profile.models.map((model) => ({
        id: model.id,
        tools: serverToolCatalog({
          ...profile,
          model: model.id,
          reportedServerTools: model.reportedMetadata?.serverTools,
          testedServerTools: model.testedServerTools,
        }),
      })),
    });
  });

  app.get('/settings/providers/:id/server-tool-stores', async (context) => {
    await requireAuth(context);
    const providerId = context.req.param('id'),
      model = context.req.query('model');
    const cursor = context.req.query('cursor');
    if (
      !v.is(uuidSchema, providerId) ||
      !model ||
      model.length > 200 ||
      (cursor?.length ?? 0) > 384
    )
      throw new HttpError(400, '检索库目录参数无效。', undefined, problem('INVALID_REQUEST'));
    const config = await context.env.LIBRARY.getByName('personal').providerConfig({
      providerId,
      model,
    });
    if (!config)
      throw new HttpError(404, '找不到这个模型。', undefined, problem('MODEL_UNAVAILABLE'));
    try {
      return json(await providerToolStores(config, cursor));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '读取供应商检索库失败。', undefined, problem('PROVIDER_FAILED'));
    }
  });
  app.post('/settings/providers/:id/server-tools/test', async (context) => {
    await requireAuth(context);
    const providerId = context.req.param('id');
    if (!v.is(uuidSchema, providerId))
      throw new HttpError(404, '找不到这个供应商。', undefined, problem('NOT_FOUND'));
    const { model, tool } = await parseBody(
      context,
      v.strictObject({
        model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
        tool: v.picklist(serverToolProbeKinds),
      }),
      { maxBytes: 2048, tooLarge: '工具测试请求过大。' },
    );
    return context.env.LIBRARY.getByName('personal').probeProviderServerTool(
      providerId,
      model,
      tool,
    );
  });

  app.post('/settings/providers/:id/models/test', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id');
    if (!v.safeParse(uuidSchema, id).success)
      throw new HttpError(404, '找不到这个供应商。', undefined, problem('NOT_FOUND'));
    const input = await parseBody(context, modelProbeInputSchema, {
      maxBytes: 2048,
      tooLarge: '测试请求过大。',
    });
    return context.env.LIBRARY.getByName('personal').probeProviderModel(
      id,
      input.model,
      input.capability,
    );
  });
}
