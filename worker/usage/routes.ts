import * as v from 'valibot';
import { problem } from '../../shared/errors/descriptor';
import {
  priceInputSchema,
  usageKinds,
  usageStatuses,
  type UsageFilter,
} from '../../shared/usage/types';
import { requireAuth, uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import type { AppContext } from '../http/response';
import { HttpError, json, parseBody } from '../http/response';

function store(context: AppContext) {
  if (!context.env.USAGE)
    throw new HttpError(503, '用量统计尚未配置。', undefined, problem('USAGE_INVALID'));
  return context.env.USAGE.getByName('personal');
}
function filter(context: AppContext): UsageFilter {
  const params = context.req.query();
  const value: UsageFilter = {};
  for (const field of ['from', 'to'] as const)
    if (params[field] !== undefined) {
      const number = Number(params[field]);
      if (!Number.isSafeInteger(number) || number < 0 || number > 8_640_000_000_000_000)
        throw new HttpError(400, '无效的时间范围。', undefined, problem('USAGE_INVALID'));
      value[field] = number;
    }
  if (value.from !== undefined && value.to !== undefined && value.from >= value.to)
    throw new HttpError(400, '结束时间须晚于开始时间。', undefined, problem('USAGE_INVALID'));
  for (const field of ['providerId', 'model'] as const)
    if (params[field]) {
      if (params[field].length > 200)
        throw new HttpError(400, '无效的统计筛选。', undefined, problem('USAGE_INVALID'));
      value[field] = params[field];
    }
  if (params.kind) {
    if (!v.is(v.picklist(usageKinds), params.kind))
      throw new HttpError(400, '无效的请求类型。', undefined, problem('USAGE_INVALID'));
    value.kind = params.kind;
  }
  if (params.status) {
    if (!v.is(v.picklist(usageStatuses), params.status))
      throw new HttpError(400, '无效的请求状态。', undefined, problem('USAGE_INVALID'));
    value.status = params.status;
  }
  if (params.cursor) {
    if (params.cursor.length > 512)
      throw new HttpError(400, '无效的分页位置。', undefined, problem('USAGE_INVALID'));
    try {
      const cursor: unknown = JSON.parse(atob(params.cursor));
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        !Number.isSafeInteger(cursor[0]) ||
        typeof cursor[1] !== 'string' ||
        cursor[1].length > 200
      )
        throw new Error();
    } catch {
      throw new HttpError(400, '无效的分页位置。', undefined, problem('USAGE_INVALID'));
    }
    value.cursor = params.cursor;
  }
  if (params.limit !== undefined) {
    const limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(400, '每页可读取 1–100 项。', undefined, problem('USAGE_INVALID'));
    value.limit = limit;
  }
  return value;
}

export function registerUsageRoutes(app: ApiRouter) {
  app.post('/usage/answers', async (context) => {
    await requireAuth(context);
    const { messageIds } = await parseBody(
      context,
      v.strictObject({ messageIds: v.array(uuidSchema) }),
    );
    return json(await store(context).answer(messageIds));
  });
  app.get('/usage/dimensions', async (context) => {
    await requireAuth(context);
    return json(await store(context).dimensions());
  });
  app.get('/usage/answers/:id', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id');
    if (!v.is(uuidSchema, id))
      throw new HttpError(400, '无效的回答。', undefined, problem('USAGE_INVALID'));
    return json(await store(context).answer(id));
  });
  app.get('/usage/prices', async (context) => {
    await requireAuth(context);
    return json(await store(context).prices());
  });
  app.put('/usage/prices', async (context) => {
    await requireAuth(context);
    return json(
      await store(context).savePrice(
        await parseBody(context, priceInputSchema, { maxBytes: 4096 }),
      ),
    );
  });
  app.get('/usage/requests', async (context) => {
    await requireAuth(context);
    return store(context).page(filter(context));
  });
  app.get('/usage/report', async (context) => {
    await requireAuth(context);
    const query = filter(context),
      zone = context.req.query('timeZone') ?? 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
    } catch {
      throw new HttpError(400, '无效的时区。', undefined, problem('USAGE_INVALID'));
    }
    return store(context).report(query, zone, context.req.query('interval') === 'hour');
  });
}
