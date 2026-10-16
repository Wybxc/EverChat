import * as v from 'valibot';
import { authenticated } from './auth';
import { HttpError,type AppContext } from './response';

export const uuidSchema = v.pipe(v.string(), v.uuid());

export const requireAuth = async (context: AppContext) => {
  if (!await authenticated(context.req.raw, context.env)) throw new HttpError(401, '请先登录你的私人空间。');
};

export const conversationId = (context: AppContext) => {
  const id = context.req.param('id');
  if (!id || !v.safeParse(uuidSchema, id).success) throw new HttpError(404, '找不到这个接口。');
  return id;
};

export const requireConversation = async (context: AppContext, id: string) => {
  const library = context.env.LIBRARY.getByName('personal');
  if (!await library.get(id)) {
    if (await library.deletedAt(id)) throw new HttpError(410, '这个对话已删除。');
    throw new HttpError(404, '找不到这个对话。');
  }
  return library;
};
