import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  sharePath,
  type ManagedShare,
  type ShareBlock,
  type SharePage,
  type SharePreview,
} from '../../../shared/sharing/types';
import { Modal, ModalTitle } from '../../components/Modal';
import { api } from '../../platform/api';
import {
  errorMessage,
  renderUiMessage,
  UiError,
  uiMessage,
  type UiMessage,
} from '../../platform/i18n/messages';
import './locales';
import { ShareContent } from './ShareContent';

export const shareUrl = (id: string, secret: string) =>
  `${location.origin}${sharePath(id)}#${secret}`;

export default function ShareDialog({
  conversationId,
  headId,
  close,
}: {
  conversationId: string;
  headId: string;
  close: () => void;
}) {
  const { t } = useTranslation('sharing', { useSuspense: false });

  const [preview, setPreview] = useState<SharePreview>(),
    [blocks, setBlocks] = useState<ShareBlock[]>([]),
    [cursor, setCursor] = useState<number | null>(null);
  const [title, setTitle] = useState(''),
    [expiry, setExpiry] = useState('never'),
    [customExpiry, setCustomExpiry] = useState(''),
    [link, setLink] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<UiMessage>(''),
    [copied, setCopied] = useState(false),
    [retry, setRetry] = useState(0);
  const operation = useRef<{ headId: string; id: string } | null>(null);
  const titleEdited = useRef(false);
  const customExpiryTime = new Date(customExpiry).getTime();
  const invalidExpiry =
    expiry === 'custom' && (!Number.isFinite(customExpiryTime) || customExpiryTime <= Date.now());
  useEffect(() => {
    if (!operation.current || operation.current.headId !== headId)
      operation.current = { headId, id: crypto.randomUUID() };
    const controller = new AbortController();
    setBusy(true);
    setError('');
    setPreview(undefined);
    setBlocks([]);
    setCursor(null);
    void api<SharePreview>(
      '/shares/preview',
      'POST',
      { operationId: operation.current.id, conversationId, headId },
      controller.signal,
      90_000,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setPreview(result);
        setBlocks(result.page.blocks);
        setCursor(result.page.cursor);
        if (!titleEdited.current) setTitle(result.share.title);
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(errorMessage(failure, uiMessage('sharing', 'previewFailed')));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [conversationId, headId, retry]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure, uiMessage('sharing', 'operationFailed')));
    } finally {
      setBusy(false);
    }
  };
  const publish = () =>
    preview &&
    perform(async () => {
      const expiresAt =
        expiry === 'never'
          ? null
          : expiry === 'custom'
            ? customExpiryTime
            : Date.now() + Number(expiry) * 1000;
      if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()))
        throw new UiError(uiMessage('sharing', 'invalidExpiry'));
      const result = await api<{ share: ManagedShare; secret: string }>(
        `/shares/${preview.share.id}/publish`,
        'POST',
        { hash: preview.share.hash, title: title.trim(), expiresAt },
      );
      setLink(shareUrl(result.share.id, result.secret));
      window.dispatchEvent(new Event('everchat:shares-changed'));
    });
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      showCloseButton
    >
      <div className="flex max-h-[min(90dvh,52rem)] w-[min(48rem,calc(100dvw-1rem))] max-w-none flex-col gap-0 p-0">
        <header className="shrink-0 px-4 py-3 pr-12">
          <ModalTitle>{t(($) => $.shareBranch)}</ModalTitle>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pb-4">
          {link ? (
            <>
              <p className="text-sm">{t(($) => $.linkHint)}</p>
              <Input
                aria-label={t(($) => $.link)}
                value={link}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() =>
                    void perform(async () => {
                      await navigator.clipboard.writeText(link);
                      setCopied(true);
                    })
                  }
                >
                  {copied ? t(($) => $.copied) : t(($) => $.copyLink)}
                </Button>
                {typeof navigator.share === 'function' && (
                  <Button
                    variant="secondary"
                    onClick={() => void perform(() => navigator.share({ title, url: link }))}
                  >
                    {t(($) => $.systemShare)}
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-40 flex-1 space-y-1 text-sm">
                  {t(($) => $.title)}
                  <Input
                    aria-label={t(($) => $.title)}
                    maxLength={120}
                    value={title}
                    onChange={(event) => {
                      titleEdited.current = true;
                      setTitle(event.target.value);
                    }}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  {t(($) => $.validity)}
                  <NativeSelect
                    aria-label={t(($) => $.validity)}
                    value={expiry}
                    disabled={busy}
                    onChange={(event) => setExpiry(event.target.value)}
                  >
                    <option value="never">{t(($) => $.never)}</option>
                    <option value="3600">{t(($) => $.oneHour)}</option>
                    <option value="86400">{t(($) => $.oneDay)}</option>
                    <option value="604800">{t(($) => $.sevenDays)}</option>
                    <option value="2592000">{t(($) => $.thirtyDays)}</option>
                    <option value="custom">{t(($) => $.customTime)}</option>
                  </NativeSelect>
                </label>
                {expiry === 'custom' && (
                  <label className="space-y-1 text-sm">
                    {t(($) => $.localExpiry)}
                    <Input
                      aria-label={t(($) => $.expiry)}
                      type="datetime-local"
                      value={customExpiry}
                      disabled={busy}
                      onChange={(event) => setCustomExpiry(event.target.value)}
                    />
                    {customExpiry && invalidExpiry && (
                      <span className="text-xs text-destructive">{t(($) => $.futureTime)}</span>
                    )}
                  </label>
                )}
              </div>
              {expiry !== 'never' && (
                <p className="text-xs text-muted-foreground">{t(($) => $.expiryHint)}</p>
              )}
              {preview && (
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.previewCount, { count: preview.share.messageCount })}
                  {preview.share.omittedAttachments > 0
                    ? ` · ${t(($) => $.omitted, { count: preview.share.omittedAttachments })}`
                    : ''}
                  {t(($) => $.fixedSnapshot)}
                </p>
              )}
              <ShareContent blocks={blocks} />
              {cursor !== null && preview && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const page = await api<SharePage>(
                        `/shares/${preview.share.id}/preview?cursor=${cursor}`,
                      );
                      setBlocks((previous) => [...previous, ...page.blocks]);
                      setCursor(page.cursor);
                    })
                  }
                >
                  {t(($) => $.continuePreview)}
                </Button>
              )}
            </>
          )}
          {error && (
            <div className="space-y-2">
              <p role="alert" className="text-sm">
                {renderUiMessage(error)}
              </p>
              {!link && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    operation.current = null;
                    setRetry((value) => value + 1);
                  }}
                >
                  {t(($) => $.retryPreview)}
                </Button>
              )}
            </div>
          )}
          {busy && (
            <p role="status" className="text-sm text-muted-foreground">
              {t(($) => $.processing)}
            </p>
          )}
        </div>
        {!link && (
          <footer className="flex shrink-0 justify-end gap-2 px-4 py-3">
            <Button
              disabled={busy || !preview || !title.trim() || invalidExpiry}
              onClick={() => void publish()}
            >
              {t(($) => $.createLink)}
            </Button>
          </footer>
        )}
      </div>
    </Modal>
  );
}
