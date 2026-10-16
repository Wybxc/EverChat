import { Modal, ModalTitle } from '../../components/Modal';
import { ActionMenuLabel, ActionMenuSeparator } from '../../components/ActionMenu';
import { ActionMenuItem } from '../../components/ActionMenu';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useId, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  Copy,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import type { ConversationInfo } from '../../../shared/conversation/types';
import { ActionMenu } from '../../components/ActionMenu';

export function ConversationActions({
  conversation,
  disabled,
  update,
  remove,
  duplicate,
  children,
  exports,
}: {
  conversation?: ConversationInfo;
  disabled: boolean;
  children: ReactNode;
  exports: ReactNode;
  update: (patch: { title?: string; pinned?: boolean; archived?: boolean }) => Promise<void>;
  remove: () => Promise<void>;
  duplicate: () => Promise<void>;
}) {
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null),
    cancelButton = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<'rename' | 'delete' | null>(null);
  const [title, setTitle] = useState(conversation?.title ?? ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const open = (next: 'rename' | 'delete') => {
    setMenuOpen(false);
    setError('');
    setTitle(conversation?.title ?? '');
    setMode(next);
  };
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setMenuOpen(false);
    setError('');
    setBusy(true);
    try {
      await action();
      setMode(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '修改失败，请重试。');
      if (!mode) setMenuOpen(true);
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mode === 'rename' && title.trim()) void perform(() => update({ title: title.trim() }));
    if (mode === 'delete') void perform(remove);
  };
  return (
    <>
      <ActionMenu
        label="更多会话操作"
        icon={<MoreHorizontal className="h-[1.1875rem] w-[1.1875rem]" />}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      >
        {children}
        {conversation && (
          <>
            <ActionMenuLabel>整理</ActionMenuLabel>
            <ActionMenuItem disabled={disabled || busy} onSelect={() => open('rename')}>
              <Pencil className="h-[0.9375rem] w-[0.9375rem]" />
              重命名
            </ActionMenuItem>
            <ActionMenuItem
              disabled={disabled || busy}
              onSelect={() => void perform(() => update({ pinned: !conversation.pinned }))}
            >
              {conversation.pinned ? (
                <PinOff className="h-[0.9375rem] w-[0.9375rem]" />
              ) : (
                <Pin className="h-[0.9375rem] w-[0.9375rem]" />
              )}
              {conversation.pinned ? '取消置顶' : '置顶'}
            </ActionMenuItem>
            <ActionMenuItem
              disabled={disabled || busy}
              onSelect={() => void perform(() => update({ archived: !conversation.archived }))}
            >
              {conversation.archived ? (
                <ArchiveRestore className="h-[0.9375rem] w-[0.9375rem]" />
              ) : (
                <Archive className="h-[0.9375rem] w-[0.9375rem]" />
              )}
              {conversation.archived ? '取消归档' : '归档'}
            </ActionMenuItem>
            <ActionMenuItem disabled={disabled || busy} onSelect={() => void perform(duplicate)}>
              <Copy className="h-[0.9375rem] w-[0.9375rem]" />
              复制对话
            </ActionMenuItem>
          </>
        )}
        <ActionMenuLabel>导出与恢复</ActionMenuLabel>
        {exports}
        {conversation && (
          <>
            <ActionMenuSeparator />
            <ActionMenuItem disabled={disabled || busy} onSelect={() => open('delete')}>
              <Trash2 className="h-[0.9375rem] w-[0.9375rem]" />
              删除对话
            </ActionMenuItem>
          </>
        )}
        {error && !mode && (
          <div>
            <span role="alert" className="whitespace-normal text-xs">
              {error}
            </span>
          </div>
        )}
      </ActionMenu>
      <Modal
        open={Boolean(mode)}
        onOpenChange={(next) => {
          if (!next) setMode(null);
        }}
        alert={mode === 'delete'}
        busy={busy}
        initialFocus={mode === 'rename' ? titleInput : cancelButton}
        aria-labelledby={`${menuId}-title`}
      >
        <div className="w-full max-w-md p-5">
          <ModalTitle id={`${menuId}-title`} className="text-lg font-semibold">
            {mode === 'delete' ? '删除对话' : '重命名'}
          </ModalTitle>
          <form onSubmit={submit}>
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
                删除“{conversation?.title}”后无法恢复，正在生成的回答也会停止。
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
                onClick={() => setMode(null)}
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
    </>
  );
}
