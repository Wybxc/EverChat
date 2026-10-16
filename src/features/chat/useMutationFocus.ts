import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Message } from '../../../shared/conversation/types';
import { hasOpenModal } from '../../components/Modal';

type FocusIntent = {
  conversationId: string;
  messageId: string;
  state: 'visible' | 'deleted';
  version: number;
  closed: boolean;
};

// HTTP may finish before the WebSocket update replaces the message's DOM.
export function useMutationFocus({
  selected,
  messages,
  visibleIds,
  navigationVersion,
  editor,
}: {
  selected: string | null;
  messages: Message[];
  visibleIds: string[];
  navigationVersion: RefObject<number>;
  editor: RefObject<HTMLTextAreaElement | null>;
}) {
  const [intent, setIntent] = useState<FocusIntent | null>(null);
  const current = useRef({ selected, version: navigationVersion.current });
  current.current = { selected, version: navigationVersion.current };
  useEffect(() => {
    if (!intent) return;
    if (selected !== intent.conversationId || navigationVersion.current !== intent.version) {
      setIntent(null);
      return;
    }
    if (!intent.closed) return;
    const cancel = () => setIntent(null);
    window.addEventListener('pointerdown', cancel, true);
    window.addEventListener('keydown', cancel, true);
    const message = messages.find((message) => message.id === intent.messageId);
    let frame = 0;
    if (
      intent.state === 'deleted'
        ? Boolean(message?.deletedAt)
        : visibleIds.includes(intent.messageId)
    ) {
      frame = requestAnimationFrame(() => {
        if (
          current.current.selected === intent.conversationId &&
          current.current.version === intent.version &&
          !hasOpenModal()
        ) {
          const target =
            document.querySelector<HTMLElement>(
              `[data-message-id="${intent.messageId}"] button[aria-label="更多消息操作"]`,
            ) ??
            [
              ...document.querySelectorAll<HTMLElement>(
                '[data-message-id] button[aria-label="更多消息操作"]',
              ),
            ].at(-1) ??
            editor.current;
          target?.focus({ preventScroll: true });
        }
        setIntent(null);
      });
    }
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', cancel, true);
      window.removeEventListener('keydown', cancel, true);
    };
  }, [intent, selected, messages, visibleIds, navigationVersion, editor]);
  return {
    prepareMutationFocus: (
      conversationId: string,
      messageId: string,
      state: FocusIntent['state'],
      version: number,
    ) => setIntent({ conversationId, messageId, state, version, closed: false }),
    closeMutationFocus: () => {
      setIntent((value) => (value ? { ...value, closed: true } : null));
    },
  };
}
