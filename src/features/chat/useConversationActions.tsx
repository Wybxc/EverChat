import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationActivity } from '../../../shared/conversation/activity';
import type { ConversationInfo } from '../../../shared/conversation/types';
import { Modal, ModalTitle } from '../../components/Modal';
import { actionMenuReturnTarget } from '../../components/ActionMenu';
import {
  errorMessage,
  renderUiMessage,
  uiMessage,
  type UiMessage,
} from '../../platform/i18n/messages';
import { storageEpoch } from '../../platform/storage';
import './locales';

export type ConversationPatch = { title?: string; pinned?: boolean };
type DialogTarget = {
  mode: 'rename' | 'delete';
  conversation: ConversationInfo;
  returnTarget: HTMLElement | null;
  fallback: HTMLElement | null;
};

const actionTarget = () => {
  const active = document.activeElement;
  return active instanceof HTMLElement
    ? active.closest('[role=menu]')
      ? actionMenuReturnTarget()
      : active
    : null;
};
const adjacentRow = () => {
  const row = actionTarget()?.closest('[data-conversation-row]');
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
  share,
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
  share?: (id: string) => void;
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
    share,
    dialog,
    close: () => setDialog(null),
    open: (mode: DialogTarget['mode'], conversation: ConversationInfo) => {
      const fallback = adjacentRow();
      const returnTarget = actionTarget();
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
  useTranslation('chat', { useSuspense: false });

  return actions.dialog ? <ConversationActionDialog actions={actions} disabled={disabled} /> : null;
}
function ConversationActionDialog({
  actions,
  disabled,
}: {
  actions: ConversationActionController;
  disabled: boolean;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });

  const { mode, conversation, fallback, returnTarget } = actions.dialog!;
  const [title, setTitle] = useState(conversation.title),
    [error, setError] = useState<UiMessage>('');
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
      setError(errorMessage(failure, uiMessage('chat', 'updateFailed')));
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
      finalFocus={() => {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active !== document.body &&
          active.checkVisibility() &&
          !active.closest('[role="dialog"], [role="alertdialog"]')
        )
          return false;
        if (deletedCurrent.current) {
          actions.restoreFocus(true);
          return false;
        }
        if (
          returnTarget?.isConnected &&
          returnTarget.checkVisibility() &&
          !returnTarget.closest('[inert]')
        )
          return returnTarget;
        if (fallback?.isConnected && fallback.checkVisibility() && !fallback.closest('[inert]'))
          return fallback;
        actions.restoreFocus();
        return false;
      }}
    >
      <div className="w-full max-w-md p-5">
        <ModalTitle className="text-lg font-semibold">
          {mode === 'delete' ? t(($) => $.deleteChat) : t(($) => $.rename)}
        </ModalTitle>
        <form onSubmit={(event) => void submit(event)}>
          {mode === 'rename' ? (
            <label className="mt-5 block text-sm">
              {t(($) => $.chatName)}
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
              {t(($) => $.deleteChatConfirmation, { title: conversation.title })}
            </p>
          )}
          {error && (
            <Alert variant="destructive" role="alert" className="mt-4 text-sm">
              {renderUiMessage(error)}
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
              {t(($) => $.cancel)}
            </Button>
            <Button
              variant={mode === 'delete' ? 'destructive' : 'default'}
              type="submit"
              disabled={disabled || busy || (mode === 'rename' && !title.trim())}
            >
              {busy ? <Spinner /> : mode === 'delete' ? t(($) => $.delete) : t(($) => $.save)}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
