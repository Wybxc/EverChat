import * as v from 'valibot';
import { problem } from '../../shared/errors/descriptor';
import { shareIdPattern } from '../../shared/sharing/types';
import { requireAuth, requireConversation, uuidSchema } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, parseBody, type AppContext } from '../http/response';

const title = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
function store(context: AppContext) {
  if (!context.env.SHARES)
    throw new HttpError(503, '分享服务尚未配置。', undefined, problem('SHARE_INCOMPLETE'));
  return context.env.SHARES.getByName('personal');
}
function id(context: AppContext) {
  const value = context.req.param('id');
  if (!shareIdPattern.test(value ?? ''))
    throw new HttpError(404, '找不到这个分享。', undefined, problem('NOT_FOUND'));
  return value!;
}
function cursor(context: AppContext) {
  const value = Number(context.req.query('cursor') ?? 0);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new HttpError(400, '分页位置无效。', undefined, problem('SHARE_INCOMPLETE'));
  return value;
}
export function registerSharingRoutes(app: ApiRouter) {
  app.post('/shares/preview', async (context) => {
    await requireAuth(context);
    const input = await parseBody(
      context,
      v.strictObject({
        operationId: uuidSchema,
        conversationId: uuidSchema,
        headId: uuidSchema,
      }),
    );
    const library = await requireConversation(context, input.conversationId),
      conversation = await library.get(input.conversationId);
    return store(context).prepare({ ...input, title: conversation!.title });
  });
  app.get('/shares/:id/preview', async (context) => {
    await requireAuth(context);
    return store(context).preview(id(context), cursor(context));
  });
  app.post('/shares/:id/publish', async (context) => {
    await requireAuth(context);
    return store(context).publish(
      id(context),
      await parseBody(
        context,
        v.strictObject({
          hash,
          title,
          expiresAt: v.optional(
            v.nullable(
              v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(8_640_000_000_000_000)),
            ),
            null,
          ),
        }),
      ),
    );
  });
  app.get('/shares', async (context) => {
    await requireAuth(context);
    let next: { createdAt: number; id: string } | undefined;
    const value = context.req.query('cursor');
    if (value !== undefined) {
      try {
        if (value.length > 256) throw new Error();
        next = JSON.parse(atob(value)) as typeof next;
        if (!next || !Number.isSafeInteger(next.createdAt) || !shareIdPattern.test(next.id))
          throw new Error();
      } catch {
        throw new HttpError(400, '分页位置无效。', undefined, problem('SHARE_INCOMPLETE'));
      }
    }
    return store(context).list(next);
  });
  app.get('/shares/:id/link', async (context) => {
    await requireAuth(context);
    return store(context).link(id(context));
  });
  app.delete('/shares/:id', async (context) => {
    await requireAuth(context);
    return store(context).delete(id(context));
  });
}
