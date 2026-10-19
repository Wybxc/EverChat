import type { DocumentPart } from '../../../shared/attachments/documents';
import type { ImagePart } from '../../../shared/attachments/images';
import type { ConversationInfo, SubmitInput } from '../../../shared/conversation/types';
import type { Snapshot } from '../../../shared/streaming/protocol';
import { type UiMessage } from '../../platform/i18n/messages';
import { read, remove, write } from '../../platform/storage';

export interface Pending {
  owner: string;
  conversation: ConversationInfo;
  input: SubmitInput;
  viewHeadId?: string | null;
  error?: UiMessage;
  images?: ImagePart[];
  files?: DocumentPart[];
  modelLabel?: string;
}

export const deletedAt = (id: string) => read<number | null>(`deleted:${id}`, null);

export function markConversationDeleted(id: string, time: number) {
  write(`deleted:${id}`, time);
  write(`snapshot:parts-v1:${id}`, { messages: [], seq: 0, deletedAt: time });
  remove([
    `draft:${id}`,
    `message-edit:${id}`,
    `conversation-settings-draft:${id}`,
    `chat-model:${id}`,
  ]);
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
    !(key.startsWith('message-edit:') && deletedAt(key.slice(13))) &&
    !(key.startsWith('chat-model:') && deletedAt(key.slice(11))) &&
    !(key.startsWith('conversation-settings-draft:') && deletedAt(key.slice(28)));
  write(key.startsWith('snapshot:') ? `snapshot:parts-v1:${key.slice(9)}` : key, value, valid);
}
