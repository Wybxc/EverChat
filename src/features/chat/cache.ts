import { read, remove, write } from '../../platform/storage';
import type { DocumentPart } from '../../../shared/attachments/documents';
import type { ImagePart } from '../../../shared/attachments/images';
import type { ConversationInfo, SubmitInput } from '../../../shared/conversation/types';
import type { Snapshot } from '../../../shared/streaming/protocol';

export interface Pending {
  conversation: ConversationInfo;
  input: SubmitInput;
  viewHeadId?: string | null;
  error?: string;
  images?: ImagePart[];
  files?: DocumentPart[];
}

export const deletedAt = (id: string) => read<number | null>(`deleted:${id}`, null);

export function markConversationDeleted(id: string, time: number) {
  write(`deleted:${id}`, time);
  write(`snapshot:parts-v1:${id}`, { messages: [], seq: 0, deletedAt: time });
  remove([`draft:${id}`, `conversation-settings-draft:${id}`]);
}

export function writePending(items: Pending[]): boolean {
  try {
    write('pending', items);
    return true;
  } catch {
    return false;
  }
}

export const cachedSnapshot = (id: string) => {
  const time = deletedAt(id);
  return time
    ? { messages: [], seq: 0, deletedAt: time }
    : read<Snapshot>(`snapshot:parts-v1:${id}`, { messages: [], seq: 0 });
};

// Check again if IndexedDB fails later, after deletion or logout.
export function writeChatCache(key: string, value: unknown) {
  const valid = () =>
    !(key.startsWith('snapshot:') && deletedAt(key.slice(9)) && !(value as Snapshot).deletedAt) &&
    !(key.startsWith('draft:') && deletedAt(key.slice(6))) &&
    !(key.startsWith('conversation-settings-draft:') && deletedAt(key.slice(28)));
  write(key.startsWith('snapshot:') ? `snapshot:parts-v1:${key.slice(9)}` : key, value, valid);
}
