import { delMany, entries, set, setMany } from 'idb-keyval';

const PREFIX = 'everchat:';
const cache = new Map<string, unknown>();
let epoch = 0;
let writesAllowed = true;
export function lockStorageWrites() {
  writesAllowed = false;
  epoch++;
}
export function resumeStorageWrites() {
  writesAllowed = true;
}
export const storageEpoch = () => epoch;
const storageKey = (key: string) => `${PREFIX}${key}`;

export async function hydrateStorage() {
  try {
    const stored = await entries<string, unknown>();
    for (const [key, value] of stored) if (key.startsWith(PREFIX)) cache.set(key, value);
  } catch {
    // IndexedDB can be unavailable in private browsing or restricted WebViews.
  }
  // Recover the synchronous fallback when IndexedDB is delayed or unavailable.
  const fallback: [string, unknown][] = [];
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const value = JSON.parse(raw) as unknown;
      if (!cache.has(key)) {
        cache.set(key, value);
        fallback.push([key, value]);
      }
    }
    if (fallback.length) await setMany(fallback);
  } catch {
    // The in-memory cache still keeps the current session usable.
  }
}

export function read<T>(key: string, fallback: T): T {
  const fullKey = storageKey(key);
  if (cache.has(fullKey)) return cache.get(fullKey) as T;
  try {
    const item = localStorage.getItem(fullKey);
    if (item) {
      const value = JSON.parse(item) as T;
      cache.set(fullKey, value);
      return value;
    }
  } catch {
    // Return the fallback when browser storage is unavailable or corrupt.
  }
  return fallback;
}

export function write(key: string, value: unknown, valid: () => boolean = () => true) {
  if (!writesAllowed || !valid()) return;
  const fullKey = storageKey(key);
  cache.set(fullKey, value);
  const persistEpoch = epoch;
  const fallback = () => {
    if (epoch !== persistEpoch) return;
    if (!valid()) return;
    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch {
      /* Cloud remains authoritative. */
    }
  };
  try {
    void set(fullKey, value).catch(fallback);
  } catch {
    fallback();
  }
  // Keep a small synchronous fallback for browsers where IndexedDB is delayed or unavailable.
  try {
    localStorage.setItem(fullKey, JSON.stringify(value));
  } catch {
    /* IndexedDB remains authoritative. */
  }
}
function discard(keys: string[]) {
  try {
    void delMany(keys).catch(() => {});
  } catch {
    /* IndexedDB can also fail synchronously. */
  }
}

export function remove(keys: string[]) {
  const fullKeys = keys.map(storageKey);
  for (const key of fullKeys) {
    cache.delete(key);
    try {
      localStorage.removeItem(key);
    } catch {
      /* Memory is already cleared. */
    }
  }
  discard(fullKeys);
}

export async function clearLocal() {
  lockStorageWrites();
  const keys = new Set(cache.keys());
  cache.clear();
  let failure: unknown;
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(PREFIX)) {
        keys.add(key);
        localStorage.removeItem(key);
      }
  } catch (error) {
    failure = error;
  }
  try {
    const stored = await entries<string, unknown>();
    for (const [key] of stored) if (key.startsWith(PREFIX)) keys.add(key);
    await delMany([...keys]);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw new Error('本地记录未能完全清除，请重试。');
}
