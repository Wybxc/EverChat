import type { ConversationInfo, Snapshot, SubmitInput } from '../shared/types';

export interface Pending { conversation: ConversationInfo; input: SubmitInput; error?: string }
export function read<T>(key: string, fallback: T): T {
  try { const item = localStorage.getItem(`everchat:${key}`); return item ? JSON.parse(item) as T : fallback; } catch { return fallback; }
}
export function write(key: string, value: unknown) {
  try { localStorage.setItem(`everchat:${key}`, JSON.stringify(value)); } catch { /* Cloud stays authoritative if browser storage is full. */ }
}
export function writePending(items: Pending[]): boolean {
  try { localStorage.setItem('everchat:pending', JSON.stringify(items)); return true; } catch { return false; }
}
export function clearLocal() {
  for (const key of Object.keys(localStorage)) if (key.startsWith('everchat:')) localStorage.removeItem(key);
}
export const cachedSnapshot = (id: string) => read<Snapshot>(`snapshot:${id}`, { messages: [], seq: 0 });
