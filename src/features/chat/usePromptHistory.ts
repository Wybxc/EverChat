import { useRef, type ChangeEvent, type KeyboardEvent } from 'react';
import { messageText } from '../../../shared/conversation/content';
import type { Message } from '../../../shared/conversation/types';

type Recall = {
  scope: string;
  entries: string[];
  index: number;
  value: string;
  modified: boolean;
};

// Recall only text from the visible branch. Editing locks navigation until the
// composer is cleared; recalling a prompt never edits its saved message.
export function usePromptHistory(
  scope: string,
  path: Message[],
  updateDraft: (text: string) => void,
) {
  const recall = useRef<Recall | null>(null);
  const current = () => {
    if (recall.current?.scope !== scope) {
      const entries = path
        .filter((message) => message.role === 'user' && !message.deletedAt && !message.summary)
        .map((message) => messageText(message))
        .filter((text) => text.trim());
      recall.current = { scope, entries, index: entries.length, value: '', modified: false };
    }
    return recall.current;
  };
  return {
    onChange(event: ChangeEvent<HTMLTextAreaElement>) {
      const value = event.currentTarget.value;
      if (value === '') recall.current = null;
      else current().modified = true;
      updateDraft(value);
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
      if (
        !['ArrowUp', 'ArrowDown'].includes(event.key) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 ||
        event.currentTarget.selectionStart !== event.currentTarget.selectionEnd
      )
        return false;
      const node = event.currentTarget;
      if (node.value === '') recall.current = null;
      const state = current();
      if (node.value !== state.value) state.modified = true;
      if (state.modified) return false;
      const index = Math.max(
        0,
        Math.min(state.entries.length, state.index + (event.key === 'ArrowUp' ? -1 : 1)),
      );
      if (index === state.index) return false;
      state.index = index;
      state.value = state.entries[index] ?? '';
      event.preventDefault();
      updateDraft(state.value);
      const value = state.value;
      requestAnimationFrame(() => {
        if (node.isConnected && node.value === value)
          node.setSelectionRange(value.length, value.length);
      });
      return true;
    },
  };
}
