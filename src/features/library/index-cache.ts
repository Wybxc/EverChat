import type { LibrarySnapshot } from '../../../shared/conversation/types';
import { api } from '../../platform/api';

type DeletionPage = Pick<LibrarySnapshot, 'deletions' | 'deletionCursor' | 'hasMoreDeletions'>;
export async function loadLibraryIndex(
  cached: LibrarySnapshot | null,
  signal: AbortSignal,
  get = <T>(path: string) => api<T>(path, 'GET', undefined, signal),
): Promise<LibrarySnapshot> {
  const first = await get<LibrarySnapshot>(`/conversations?after=${cached?.deletionCursor ?? 0}`);
  let page: DeletionPage = first;
  // Restoring a database resets both its revision and deletion cursor domain.
  if (cached && cached.watermark.epoch !== first.watermark.epoch)
    page = await get<DeletionPage>('/conversations/deletions?after=0');
  const deletions = [...page.deletions];
  while (page.hasMoreDeletions) {
    const next = await get<DeletionPage>(`/conversations/deletions?after=${page.deletionCursor}`);
    if (next.deletionCursor <= page.deletionCursor) throw new Error('Invalid deletion cursor');
    deletions.push(...next.deletions);
    page = next;
  }
  const deleted = new Set(deletions.map((item) => item.id));
  return {
    ...first,
    conversations: first.conversations.filter((item) => !deleted.has(item.id)),
    activity: Object.fromEntries(Object.entries(first.activity).filter(([id]) => !deleted.has(id))),
    deletions,
    deletionCursor: page.deletionCursor,
    hasMoreDeletions: false,
  };
}
