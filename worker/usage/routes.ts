import * as v from 'valibot';
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
  if (!context.env.USAGE) throw new HttpError(503, '用量统计尚未配置。');
  return context.env.USAGE.getByName('personal');
}
function filter(context: AppContext): UsageFilter {
  const params = context.req.query();
  const value: UsageFilter = {};
  for (const field of ['from', 'to'] as const)
    if (params[field] !== undefined) {
      const number = Number(params[field]);
      if (!Number.isSafeInteger(number) || number < 0 || number > 8_640_000_000_000_000)
        throw new HttpError(400, '无效的时间范围。');
      value[field] = number;
    }
  if (value.from !== undefined && value.to !== undefined && value.from >= value.to)
    throw new HttpError(400, '结束时间须晚于开始时间。');
  for (const field of ['providerId', 'model'] as const)
    if (params[field]) {
      if (params[field].length > 200) throw new HttpError(400, '无效的统计筛选。');
      value[field] = params[field];
    }
  if (params.kind) {
    if (!v.is(v.picklist(usageKinds), params.kind)) throw new HttpError(400, '无效的请求类型。');
    value.kind = params.kind;
  }
  if (params.status) {
    if (!v.is(v.picklist(usageStatuses), params.status))
      throw new HttpError(400, '无效的请求状态。');
    value.status = params.status;
  }
  if (params.cursor) {
    if (params.cursor.length > 512) throw new HttpError(400, '无效的分页位置。');
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
      throw new HttpError(400, '无效的分页位置。');
    }
    value.cursor = params.cursor;
  }
  if (params.limit !== undefined) {
    const limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new HttpError(400, '每页可读取 1–100 项。');
    value.limit = limit;
  }
  return value;
}

export function registerUsageRoutes(app: ApiRouter) {
  app.get('/usage/dimensions', async (context) => {
    await requireAuth(context);
    return json(await store(context).dimensions());
  });
  app.get('/usage/answers/:id', async (context) => {
    await requireAuth(context);
    const id = context.req.param('id');
    if (!v.is(uuidSchema, id)) throw new HttpError(400, '无效的回答。');
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
      throw new HttpError(400, '无效的时区。');
    }
    return store(context).report(query, zone, context.req.query('interval') === 'hour');
  });
  app.put('/usage/requests/:id/correction', async (context) => {
    await requireAuth(context);
    const input = await parseBody(
      context,
      v.strictObject({
        amount: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/)),
        reason: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
      }),
    );
    try {
      return json(
        await store(context).correct(context.req.param('id'), input.amount, input.reason),
      );
    } catch {
      throw new HttpError(400, '无法修正此请求，请检查币种、金额和原因。');
    }
  });
  app.post('/usage/requests/:id/reprice', async (context) => {
    await requireAuth(context);
    try {
      return json(await store(context).reprice(context.req.param('id')));
    } catch {
      throw new HttpError(400, '请先配置价格，仅可补算此前未定价的已结束请求。');
    }
  });
}
