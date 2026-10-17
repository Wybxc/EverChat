import type { Context } from 'hono';
import * as v from 'valibot';
import type { Env } from './env';
import type { AccessPrincipal } from './auth';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export function json(body: unknown, status = 200, headers?: HeadersInit) {
  const result = new Headers(headers);
  result.set('Content-Type', 'application/json; charset=utf-8');
  result.set('Cache-Control', 'no-store');
  result.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers: result });
}

/** Wrap a native RPC response without decoding large histories in the Free Worker. */
export function jsonWithStream(
  body: Record<string, unknown>,
  key: string,
  source: Response,
  status = 200,
) {
  if (!source.ok || !source.body) return source;
  const reader = source.body.getReader(),
    encoder = new TextEncoder();
  const prefix =
    JSON.stringify(body).slice(0, -1) +
    (Object.keys(body).length ? ',' : '') +
    JSON.stringify(key) +
    ':';
  let started = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(encoder.encode(prefix));
          return;
        }
        try {
          const { done, value } = await reader.read();
          if (done) {
            reader.releaseLock();
            controller.enqueue(encoder.encode('}'));
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    }),
    { status, headers: json(null).headers },
  );
}

export type AppEnv = { Bindings: Env; Variables: { principal: AccessPrincipal } };
export type AppContext = Context<AppEnv>;

/** Decode bounded JSON in the owning DO; native streams do not count against object RPC payload limits. */
export async function readJsonStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  tooLarge: string,
): Promise<unknown> {
  const reader = body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let text = '',
    size = 0,
    expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 90_000);
  try {
    while (true) {
      const next = await reader.read();
      if (expired) throw new HttpError(408, '请求上传超时。');
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new HttpError(413, tooLarge);
      text += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof HttpError ? error : new HttpError(400, '请求内容不是有效的 JSON 对象。');
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export async function parseBody<TSchema extends v.GenericSchema>(
  context: AppContext,
  schema: TSchema,
  options: { maxBytes?: number; tooLarge?: string } = {},
): Promise<v.InferOutput<TSchema>> {
  const request = context.req.raw;
  if (!request.headers.get('Content-Type')?.includes('application/json'))
    throw new HttpError(415, '请使用 JSON 请求。');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求内容为空。');
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > (options.maxBytes ?? 64_000)) {
      await reader.cancel();
      throw new HttpError(413, options.tooLarge ?? '请求超过此接口的大小保护限制。');
    }
    text += decoder.decode(value, { stream: true });
  }
  try {
    const result = v.safeParse(schema, JSON.parse(text + decoder.decode()));
    if (!result.success) throw new Error();
    return result.output;
  } catch {
    throw new HttpError(400, '请求内容不是有效的 JSON 对象。');
  }
}
