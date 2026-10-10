import { delMany, entries, set, setMany } from 'idb-keyval';
import type { ConversationInfo, Snapshot, SubmitInput } from '../shared/types';

export interface Pending { conversation: ConversationInfo; input: SubmitInput; error?: string }

const PREFIX = 'everchat:';
const cache = new Map<string, unknown>();
const storageKey = (key: string) => `${PREFIX}${key}`;

export async function hydrateStorage() {
  try {
    const stored = await entries<string, unknown>();
    for (const [key, value] of stored) if (key.startsWith(PREFIX)) cache.set(key, value);
  } catch {
    // IndexedDB can be unavailable in private browsing or restricted WebViews.
  }
  // Migrate the previous localStorage cache once, then keep it as a fallback for this session.
  const migrated: [string, unknown][] = [];
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const value = JSON.parse(raw) as unknown;
      if (!cache.has(key)) {
        cache.set(key, value);
        migrated.push([key, value]);
      }
    }
    if (migrated.length) await setMany(migrated);
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

function persist(key: string, value: unknown) {
  const fullKey = storageKey(key);
  cache.set(fullKey, value);
  void set(fullKey, value).catch(() => {
    try { localStorage.setItem(fullKey, JSON.stringify(value)); } catch { /* Cloud remains authoritative. */ }
  });
  // Keep a small synchronous fallback for browsers where IndexedDB is delayed or unavailable.
  try { localStorage.setItem(fullKey, JSON.stringify(value)); } catch { /* IndexedDB remains authoritative. */ }
}

export function write(key: string, value: unknown) { persist(key, value); }

export function writePending(items: Pending[]): boolean {
  try { persist('pending', items); return true; } catch { return false; }
}

export function clearLocal() {
  const keys = [...cache.keys()];
  cache.clear();
  void delMany(keys).catch(() => {});
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* The in-memory cache is already cleared. */ }
}

export const cachedSnapshot = (id: string) => read<Snapshot>(`snapshot:${id}`, { messages: [], seq: 0 });
