import { Modal, ModalTitle } from '../../components/Modal';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { X } from 'lucide-react';
import type { Message } from '../../../shared/conversation/types';

export function MessageDeleteDialog({
  message,
  affectsSummaries = false,
  confirm,
  close,
  restoreCompletedFocus,
}: {
  message: Message;
  affectsSummaries?: boolean;
  confirm: () => Promise<void>;
  close: () => void;
  restoreCompletedFocus?: () => void;
}) {
  const titleId = useId(),
    cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const confirmed = useRef(false);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await confirm();
      confirmed.current = true;
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      alert
      busy={busy}
      initialFocus={cancel}
      aria-labelledby={titleId}
      onCloseAutoFocus={(event) => {
        if (confirmed.current && restoreCompletedFocus) {
          event.preventDefault();
          restoreCompletedFocus();
        }
      }}
    >
      <div className="p-5 flex max-h-[85dvh] max-w-2xl flex-col overflow-hidden">
        <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
          <ModalTitle id={titleId} className="text-lg font-semibold">
            {message.summary ? '删除摘要' : '删除消息'}
          </ModalTitle>
          <div>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={close}
              aria-label="关闭消息操作"
              disabled={busy}
            >
              <X className="h-[1.125rem] w-[1.125rem]" />
            </Button>
          </div>
        </div>
        <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
          <p>
            {message.summary
              ? '删除摘要？原始消息仍保留。'
              : affectsSummaries
                ? '删除这条消息？覆盖它的历史摘要也会清除。'
                : '删除这条消息？'}
          </p>
          {error && (
            <p role="alert" className="mt-3 shrink-0 text-sm">
              {error}
            </p>
          )}
          <div className="dialog-actions shrink-0">
            <Button
              variant="secondary"
              ref={cancel}
              type="button"
              disabled={busy}
              onClick={() => close()}
            >
              取消
            </Button>
            <Button variant="destructive" type="submit" disabled={busy}>
              {busy && <Spinner />}
              确认删除
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
