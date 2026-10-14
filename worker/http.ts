import type { Context } from 'hono';
import * as v from 'valibot';
import type { Env } from './env';
import { MAX_BACKUP_BYTES, validateBackup, type EverChatBackup } from '../shared/backup';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function json(body: unknown, status = 200, headers?: HeadersInit) {
  const result = new Headers(headers);
  result.set('Content-Type', 'application/json; charset=utf-8');
  result.set('Cache-Control', 'no-store');
  result.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers: result });
}

export type AppContext = Context<{ Bindings: Env }>;

export async function parseBody<TSchema extends v.GenericSchema>(context: AppContext, schema: TSchema): Promise<v.InferOutput<TSchema>> {
  const request = context.req.raw;
  if (!request.headers.get('Content-Type')?.includes('application/json')) throw new HttpError(415, '请使用 JSON 请求。');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求内容为空。');
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64_000) { await reader.cancel(); throw new HttpError(413, '消息太长，请控制在 16,000 字以内。'); }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const result = v.safeParse(schema, JSON.parse(text + decoder.decode()));
    if (!result.success) throw new Error();
    return result.output;
  } catch { throw new HttpError(400, '请求内容不是有效的 JSON 对象。'); }
}

export async function parseBackup(context: AppContext): Promise<EverChatBackup> {
  const request = context.req.raw;
  if (!request.headers.get('Content-Type')?.includes('application/json')) throw new HttpError(415, '请使用 JSON 请求。');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求内容为空。');
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BACKUP_BYTES) { await reader.cancel(); throw new HttpError(413, '备份文件过大，请拆分后重试。'); }
      text += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(text + decoder.decode());
    return validateBackup(value);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '备份文件格式无效或版本不受支持。');
  }
}
