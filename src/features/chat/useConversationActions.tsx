import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import type { ConversationInfo } from '../../../shared/conversation/types';
import type { ConversationActivity } from '../../../shared/conversation/activity';
import { storageEpoch } from '../../platform/storage';
import { Modal, ModalTitle } from '../../components/Modal';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

export type ConversationPatch = { title?: string; pinned?: boolean };
type DialogTarget = {
  mode: 'rename' | 'delete';
  conversation: ConversationInfo;
  returnTarget: HTMLElement | null;
  fallback: HTMLElement | null;
};

const adjacentRow = () => {
  const row = document.activeElement?.closest('[data-conversation-row]');
  const sibling = row?.nextElementSibling ?? row?.previousElementSibling;
  return sibling?.querySelector<HTMLElement>('a') ?? null;
};

/** A single page-level controller keeps every command bound to its captured target. */
export function useConversationActions({
  enabled,
  update,
  remove,
  duplicate,
  copyLink,
  generateTitle,
  titleConfigured = false,
  viewTask,
  stopTask,
  beforeDialog,
  restoreFocus,
}: {
  enabled: boolean;
  update: (id: string, patch: ConversationPatch) => Promise<void>;
  remove: (id: string) => Promise<void | 'composer'>;
  duplicate: (id: string) => Promise<void>;
  copyLink: (id: string) => Promise<void>;
  generateTitle?: (id: string) => Promise<void>;
  titleConfigured?: boolean;
  viewTask: (id: string, activity: Exclude<ConversationActivity, { status: 'idle' }>) => void;
  stopTask: (
    id: string,
    activity: Exclude<ConversationActivity, { status: 'idle' }>,
  ) => Promise<void>;
  beforeDialog: () => void;
  restoreFocus: (preferComposer?: boolean) => void;
}) {
  const locks = useRef(new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  useEffect(() => {
    if (!enabled) {
      locks.current.clear();
      setBusy(new Set());
      setDialog(null);
    }
  }, [enabled]);
  const perform = async (id: string, action: () => Promise<void>) => {
    if (locks.current.has(id)) return;
    const epoch = storageEpoch(),
      fallback = adjacentRow(),
      inDialog = Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]'));
    locks.current.add(id);
    setBusy(new Set(locks.current));
    try {
      await action();
      if (epoch !== storageEpoch()) return;
      if (!inDialog)
        requestAnimationFrame(() => {
          if (epoch !== storageEpoch() || document.activeElement !== document.body) return;
          if (fallback?.isConnected && fallback.checkVisibility() && !fallback.closest('[inert]'))
            fallback.focus({ preventScroll: true });
          else restoreFocus();
        });
    } catch (error) {
      if (epoch === storageEpoch()) throw error;
    } finally {
      if (epoch === storageEpoch()) {
        locks.current.delete(id);
        setBusy(new Set(locks.current));
      }
    }
  };
  return {
    dialog,
    close: () => setDialog(null),
    open: (mode: DialogTarget['mode'], conversation: ConversationInfo) => {
      const fallback = adjacentRow();
      const returnTarget =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      beforeDialog();
      setDialog({ mode, conversation, fallback, returnTarget });
    },
    busy,
    perform,
    update,
    remove,
    duplicate,
    copyLink,
    generateTitle,
    titleConfigured,
    viewTask,
    stopTask,
    restoreFocus,
  };
}
export type ConversationActionController = ReturnType<typeof useConversationActions>;

export function ConversationActionDialogs({
  actions,
  disabled,
}: {
  actions: ConversationActionController;
  disabled: boolean;
}) {
  return actions.dialog ? <ConversationActionDialog actions={actions} disabled={disabled} /> : null;
}
function ConversationActionDialog({
  actions,
  disabled,
}: {
  actions: ConversationActionController;
  disabled: boolean;
}) {
  const { mode, conversation, fallback, returnTarget } = actions.dialog!;
  const [title, setTitle] = useState(conversation.title),
    [error, setError] = useState('');
  const titleInput = useRef<HTMLInputElement>(null),
    cancelButton = useRef<HTMLButtonElement>(null),
    deletedCurrent = useRef(false);
  const busy = actions.busy.has(conversation.id);
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || busy || (mode === 'rename' && !title.trim())) return;
    setError('');
    const epoch = storageEpoch();
    try {
      await actions.perform(conversation.id, async () => {
        if (mode === 'rename') await actions.update(conversation.id, { title: title.trim() });
        else deletedCurrent.current = (await actions.remove(conversation.id)) === 'composer';
      });
      if (epoch === storageEpoch()) actions.close();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '修改失败，请重试。');
    }
  };
  return (
    <Modal
      open
      onOpenChange={(next) => {
        if (!next) actions.close();
      }}
      alert={mode === 'delete'}
      busy={busy}
      initialFocus={mode === 'rename' ? titleInput : cancelButton}
      onCloseAutoFocus={(event) => {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active !== document.body &&
          active.checkVisibility() &&
          !active.closest('[role="dialog"], [role="alertdialog"]')
        )
          return;
        if (deletedCurrent.current) {
          event.preventDefault();
          actions.restoreFocus(true);
          return;
        }
        // Modal restores a surviving trigger; supply a useful fallback if its row left the list.
        if (
          returnTarget?.isConnected &&
          returnTarget.checkVisibility() &&
          !returnTarget.closest('[inert]')
        ) {
          event.preventDefault();
          returnTarget.focus({ preventScroll: true });
          return;
        }
        if (fallback?.isConnected && fallback.checkVisibility() && !fallback.closest('[inert]')) {
          event.preventDefault();
          fallback.focus({ preventScroll: true });
        } else {
          event.preventDefault();
          actions.restoreFocus();
        }
      }}
    >
      <div className="w-full max-w-md p-5">
        <ModalTitle className="text-lg font-semibold">
          {mode === 'delete' ? '删除对话' : '重命名'}
        </ModalTitle>
        <form onSubmit={(event) => void submit(event)}>
          {mode === 'rename' ? (
            <label className="mt-5 block text-sm">
              对话名称
              <Input
                ref={titleInput}
                className="mt-2 w-full"
                required
                maxLength={80}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={busy}
              />
            </label>
          ) : (
            <p className="mt-4 break-words text-sm leading-6">
              删除“{conversation.title}”后无法恢复，正在生成的回答也会停止。
            </p>
          )}
          {error && (
            <Alert variant="destructive" role="alert" className="mt-4 text-sm">
              {error}
            </Alert>
          )}
          <div className="dialog-actions">
            <Button
              variant="secondary"
              ref={cancelButton}
              type="button"
              onClick={actions.close}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              variant={mode === 'delete' ? 'destructive' : 'default'}
              type="submit"
              disabled={disabled || busy || (mode === 'rename' && !title.trim())}
            >
              {busy ? <Spinner /> : mode === 'delete' ? '删除' : '保存'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
