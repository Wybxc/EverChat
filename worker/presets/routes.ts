import * as v from 'valibot';
import { promptPresetInputSchema } from '../../shared/presets/schema';
import { requireAuth,uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError,json,parseBody } from '../http/response';



export function registerPresetsRoutes(app: ApiRouter) {
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
}
