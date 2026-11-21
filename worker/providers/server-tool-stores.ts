import type { ProviderConfig } from '../../shared/providers/types';
import { problem } from '../../shared/errors/descriptor';
import { serverToolCatalog } from '../../shared/tools/server-tools';
import { HttpError, readJsonStream } from '../http/response';

type StorePage = { stores: { id: string; name: string }[]; cursor?: string };
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

export async function providerToolStores(
  config: ProviderConfig,
  cursor?: string,
): Promise<StorePage> {
  const capability = serverToolCatalog(config).find(({ tool }) => tool === 'file-search');
  if (!capability || !config.apiKey)
    throw new HttpError(
      404,
      '当前模型没有可用的文件检索库。',
      undefined,
      problem('MODEL_TOOLS_UNSUPPORTED'),
    );
  const openai = capability.vendor === 'openai';
  const endpoint = new URL(
    openai
      ? 'https://api.openai.com/v1/vector_stores'
      : 'https://generativelanguage.googleapis.com/v1beta/fileSearchStores',
  );
  endpoint.searchParams.set(openai ? 'limit' : 'pageSize', '20');
  if (cursor) endpoint.searchParams.set(openai ? 'after' : 'pageToken', cursor);
  const headers: Record<string, string> = openai
    ? { Authorization: `Bearer ${config.apiKey}` }
    : { 'x-goog-api-key': config.apiKey };
  const response = await fetch(endpoint, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(
      502,
      '读取供应商检索库失败，请检查当前连接的权限。',
      undefined,
      problem('PROVIDER_FAILED'),
    );
  }
  const payload = object(
    await readJsonStream(response.body, 128 * 1024, '检索库目录超过保存大小。'),
  );
  const rows = openai ? payload.data : payload.fileSearchStores;
  const prefix = openai ? /^vs_[a-zA-Z0-9_-]{1,150}$/ : /^fileSearchStores\/[a-zA-Z0-9_-]{1,150}$/;
  const stores = Array.isArray(rows)
    ? rows.slice(0, 20).flatMap((value) => {
        const item = object(value),
          id = openai ? item.id : item.name;
        const title = openai ? item.name : item.displayName;
        if (typeof id !== 'string' || !prefix.test(id) || id.includes(config.apiKey!)) return [];
        return [
          {
            id,
            name:
              typeof title === 'string' && title.trim() && !title.includes(config.apiKey!)
                ? title.trim().slice(0, 200)
                : id,
          },
        ];
      })
    : [];
  const next = openai
    ? payload.has_more === true
      ? payload.last_id
      : undefined
    : payload.nextPageToken;
  return {
    stores,
    ...(typeof next === 'string' &&
    next.length <= 384 &&
    next !== cursor &&
    !next.includes(config.apiKey)
      ? { cursor: next }
      : {}),
  };
}
