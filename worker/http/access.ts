import * as v from 'valibot';
import { HttpError, type AppContext } from './response';

export const uuidSchema = v.pipe(v.string(), v.uuid());

export const requireAuth = async (context: AppContext) => {
  const principal = context.get('principal');
  if (!principal) throw new HttpError(401, '请重新登录。', 'AUTH_REQUIRED');
  return principal;
};

export const conversationId = (context: AppContext) => {
  const id = context.req.param('id');
  if (!id || !v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到这个接口。');
  return id;
};

export const requireConversation = async (context: AppContext, id: string) => {
  const library = context.env.LIBRARY.getByName('personal');
  if (!(await library.get(id))) {
    if (await library.deletedAt(id)) throw new HttpError(410, '这个对话已删除。');
    throw new HttpError(404, '找不到这个对话。');
  }
  return library;
};
