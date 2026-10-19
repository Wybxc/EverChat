import { useTranslation } from 'react-i18next';
import './locales';
import { useLayoutEffect, useRef, useState, type SubmitEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
  MAX_MESSAGE_TEXT_BYTES,
  MESSAGE_TEXT_LIMIT_MESSAGE,
  messageTextFits,
} from '../../../shared/conversation/limits';
import { useComposerSize } from './useComposerSize';

export function MessageEditor({
  content,
  user,
  hasAttachments,
  change,
  save,
  cancel,
}: {
  content: string;
  user: boolean;
  hasAttachments: boolean;
  change: (content: string) => void;
  save: () => Promise<void>;
  cancel: () => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });

  const input = useRef<HTMLTextAreaElement>(null);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useComposerSize(input, content);
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
    input.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  const submit = async (event?: SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (lock.current || (!content.trim() && !hasAttachments)) return;
    if (!messageTextFits(content.trim())) {
      setError(MESSAGE_TEXT_LIMIT_MESSAGE);
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await save();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(($) => $.saveFailed));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      data-testid="message-editor"
      aria-label={user ? t(($) => $.editQuestion) : t(($) => $.editAnswer)}
      className="message-editor space-y-2"
      onSubmit={(event) => void submit(event)}
    >
      <Textarea
        ref={input}
        aria-label={user ? t(($) => $.questionContent) : t(($) => $.answerContent)}
        value={content}
        maxLength={MAX_MESSAGE_TEXT_BYTES}
        disabled={busy}
        className="min-h-28 max-h-[min(24rem,45dvh)] resize-none overflow-y-auto text-base leading-7 md:text-base"
        onChange={(event) => {
          change(event.target.value);
          setError('');
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            void submit();
          }
        }}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 bg-background py-1">
        <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>
          {t(($) => $.cancelEditing)}
        </Button>
        <Button type="submit" disabled={busy || (!content.trim() && !hasAttachments)}>
          {busy && <Spinner />}
          {user ? t(($) => $.saveAndRegenerate) : t(($) => $.saveVersion)}
        </Button>
      </div>
    </form>
  );
}
