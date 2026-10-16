import { get, set } from 'idb-keyval';
import { parseModelCatalog, type ModelCatalog } from '../../../shared/models/catalog';

const CACHE_KEY = 'public-model-catalog:v1',
  TTL = 7 * 24 * 60 * 60 * 1000;
interface CatalogCache {
  data: ModelCatalog;
  updatedAt: number;
}
let memory: CatalogCache | null = null,
  pending: Promise<CatalogCache | null> | null = null;
let nextAttempt = 0;

export function loadModelCatalog(): Promise<CatalogCache | null> {
  if (Date.now() < nextAttempt) return Promise.resolve(memory);
  if (memory && Date.now() - memory.updatedAt < TTL) return Promise.resolve(memory);
  if (pending) return pending;
  pending = (async () => {
    let cached = memory;
    try {
      cached ??= (await get<CatalogCache>(CACHE_KEY)) ?? null;
    } catch {
      /* Private mode may disable storage. */
    }
    if (
      cached &&
      (!Number.isSafeInteger(cached.updatedAt) ||
        cached.updatedAt <= 0 ||
        cached.updatedAt > Date.now() ||
        !cached.data ||
        typeof cached.data !== 'object' ||
        Array.isArray(cached.data))
    )
      cached = null;
    if (cached && Date.now() - cached.updatedAt < TTL) return (memory = cached);
    try {
      const response = await fetch('https://models.dev/api.json', {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || !response.body) throw new Error('Directory unavailable');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.byteLength;
          if (size > 12 * 1024 * 1024) throw new Error('Directory too large');
          chunks.push(result.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const data = parseModelCatalog(JSON.parse(new TextDecoder().decode(bytes)));
      if (!Object.keys(data).length) throw new Error('Empty directory');
      memory = { data, updatedAt: Date.now() };
      try {
        await set(CACHE_KEY, memory);
      } catch {
        /* The in-memory cache still works. */
      }
      return memory;
    } catch {
      nextAttempt = Date.now() + 60 * 60 * 1000;
      return (memory = cached);
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}
