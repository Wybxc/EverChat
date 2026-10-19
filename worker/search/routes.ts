import { problem } from '../../shared/errors/descriptor';
import { SEARCH_QUERY_LIMIT } from '../../shared/search/query';
import { requireAuth } from '../http/access';
import type { ApiRouter } from '../http/app';
import { HttpError, json } from '../http/response';

export function registerSearchRoutes(app: ApiRouter) {
  app.get('/search', async (context) => {
    await requireAuth(context);
    const query = context.req.query('q')?.trim() ?? '',
      cursor = context.req.query('cursor');
    if (!query || query.length > SEARCH_QUERY_LIMIT || (cursor && cursor.length > 4096))
      throw new HttpError(400, '搜索参数无效。', undefined, problem('SEARCH_STALE'));
    const result = await context.env.LIBRARY.getByName('personal').search(query, cursor);
    if ('status' in result)
      return json({ error: result.error, issue: result.issue }, result.status);
    return json(result);
  });
}
