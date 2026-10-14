import type { ImagePart } from '../shared/images';
import { delMany, entries, set, setMany } from 'idb-keyval';
import type { ConversationInfo, Snapshot, SubmitInput } from '../shared/types';

export interface Pending { conversation: ConversationInfo; input: SubmitInput; error?: string; images?: ImagePart[] }

const PREFIX = 'everchat:';
const cache = new Map<string, unknown>();
let epoch = 0;
export const storageEpoch = () => epoch;
// Snapshot payloads have a new DTO. Refetch authoritative data instead of converting old caches.
const storageKey = (key: string) => `${PREFIX}${key.startsWith('snapshot:') ? `snapshot:parts-v1:${key.slice(9)}` : key}`;

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

function persist(key: string, value: unknown) {
  const fullKey = storageKey(key);
  cache.set(fullKey, value);
  const persistEpoch = epoch;
  const fallback = () => {
    if (epoch !== persistEpoch) return;
    if (key.startsWith('snapshot:') && deletedAt(key.slice(9)) && !(value as Snapshot).deletedAt) return;
    if (key.startsWith('draft:') && deletedAt(key.slice(6))) return;
    if (key.startsWith('conversation-settings-draft:') && deletedAt(key.slice(28))) return;
    try { localStorage.setItem(fullKey, JSON.stringify(value)); } catch { /* Cloud remains authoritative. */ }
  };
  try { void set(fullKey, value).catch(fallback); }
  catch { fallback(); }
  // Keep a small synchronous fallback for browsers where IndexedDB is delayed or unavailable.
  try { localStorage.setItem(fullKey, JSON.stringify(value)); } catch { /* IndexedDB remains authoritative. */ }
}
function discard(keys: string[]) {
  try { void delMany(keys).catch(() => {}); } catch { /* IndexedDB can also fail synchronously. */ }
}

export const deletedAt = (id: string) => read<number | null>(`deleted:${id}`, null);
export function write(key: string, value: unknown) {
  if (key.startsWith('snapshot:') && deletedAt(key.slice(9)) && !(value as Snapshot).deletedAt) return;
  if (key.startsWith('draft:') && deletedAt(key.slice(6))) return;
  if (key.startsWith('conversation-settings-draft:') && deletedAt(key.slice(28))) return;
  persist(key, value);
}
export function markConversationDeleted(id: string, time: number) {
  persist(`deleted:${id}`, time);
  persist(`snapshot:${id}`, { messages: [], seq: 0, deletedAt: time });
  const keys = [storageKey(`draft:${id}`), storageKey(`conversation-settings-draft:${id}`)];
  for (const key of keys) {
    cache.delete(key);
    try { localStorage.removeItem(key); } catch { /* The deletion marker also prevents recovering the draft. */ }
  }
  discard(keys);
}

export function writePending(items: Pending[]): boolean {
  try { persist('pending', items); return true; } catch { return false; }
}

export function clearLocal() {
  epoch++;
  const keys = [...cache.keys()];
  cache.clear();
  discard(keys);
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
  } catch { /* The in-memory cache is already cleared. */ }
}

export const cachedSnapshot = (id: string) => {
  const time = deletedAt(id);
  return time ? { messages: [], seq: 0, deletedAt: time } : read<Snapshot>(`snapshot:${id}`, { messages: [], seq: 0 });
};
