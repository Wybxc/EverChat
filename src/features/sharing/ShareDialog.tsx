import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Modal, ModalTitle } from '../../components/Modal';
import { api } from '../../platform/api';
import {
  sharePath,
  type ManagedShare,
  type ShareBlock,
  type ShareExpiry,
  type SharePage,
  type SharePreview,
} from '../../../shared/sharing/types';
import { ShareContent } from './ShareContent';

export const expiryValue = (expiry: ShareExpiry) => (expiry === null ? 'never' : String(expiry));
export const parseExpiry = (value: string): ShareExpiry =>
  value === 'never' ? null : (Number(value) as 1 | 7 | 30);
export function ExpiryOptions() {
  return (
    <>
      <option value="1">1 天</option>
      <option value="7">7 天</option>
      <option value="30">30 天</option>
      <option value="never">永久</option>
    </>
  );
}
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
  const [reasoning, setReasoning] = useState(false),
    [expiry, setExpiry] = useState<ShareExpiry>(7);
  const [preview, setPreview] = useState<SharePreview>(),
    [blocks, setBlocks] = useState<ShareBlock[]>([]),
    [cursor, setCursor] = useState<number | null>(null);
  const [title, setTitle] = useState(''),
    [link, setLink] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false),
    [retry, setRetry] = useState(0);
  const operation = useRef<{ reasoning: boolean; headId: string; id: string } | null>(null);
  const titleEdited = useRef(false);
  useEffect(() => {
    if (
      !operation.current ||
      operation.current.reasoning !== reasoning ||
      operation.current.headId !== headId
    )
      operation.current = { reasoning, headId, id: crypto.randomUUID() };
    const controller = new AbortController();
    setBusy(true);
    setError('');
    setPreview(undefined);
    setBlocks([]);
    setCursor(null);
    void api<SharePreview>(
      '/shares/preview',
      'POST',
      { operationId: operation.current.id, conversationId, headId, includeReasoning: reasoning },
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
          setError(failure instanceof Error ? failure.message : '预览失败。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [conversationId, headId, reasoning, retry]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  };
  const publish = () =>
    preview &&
    perform(async () => {
      const result = await api<{ share: ManagedShare; secret: string }>(
        `/shares/${preview.share.id}/publish`,
        'POST',
        { hash: preview.share.hash, title: title.trim(), expiry },
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
          <ModalTitle>分享当前分支</ModalTitle>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pb-4">
          {link ? (
            <>
              <p className="text-sm">拥有链接的人均可查看此快照。</p>
              <Input
                aria-label="只读分享链接"
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
                  {copied ? '已复制' : '复制分享链接'}
                </Button>
                {typeof navigator.share === 'function' && (
                  <Button
                    variant="secondary"
                    onClick={() => void perform(() => navigator.share({ title, url: link }))}
                  >
                    系统分享
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-40 flex-1 space-y-1 text-sm">
                  分享标题
                  <Input
                    aria-label="分享标题"
                    maxLength={120}
                    value={title}
                    onChange={(event) => {
                      titleEdited.current = true;
                      setTitle(event.target.value);
                    }}
                  />
                </label>
                <label className="space-y-1 text-sm">
                  有效期
                  <NativeSelect
                    aria-label="分享有效期"
                    value={expiryValue(expiry)}
                    onChange={(event) => setExpiry(parseExpiry(event.target.value))}
                  >
                    <ExpiryOptions />
                  </NativeSelect>
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  aria-label="包含思考内容"
                  checked={reasoning}
                  disabled={busy}
                  onCheckedChange={setReasoning}
                />
                包含思考内容
              </label>
              {preview && (
                <p className="text-xs text-muted-foreground">
                  {preview.share.messageCount} 条消息 · 固定快照
                  {preview.share.omittedAttachments > 0
                    ? ` · 已省略 ${preview.share.omittedAttachments} 个附件`
                    : ''}
                  。后续修改不会同步到此链接。
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
                  继续预览
                </Button>
              )}
            </>
          )}
          {error && (
            <div className="space-y-2">
              <p role="alert" className="text-sm">
                {error}
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
                  重新预览
                </Button>
              )}
            </div>
          )}
          {busy && (
            <p role="status" className="text-sm text-muted-foreground">
              正在处理…
            </p>
          )}
        </div>
        {!link && (
          <footer className="flex shrink-0 justify-end gap-2 px-4 py-3">
            <Button disabled={busy || !preview || !title.trim()} onClick={() => void publish()}>
              生成只读链接
            </Button>
          </footer>
        )}
      </div>
    </Modal>
  );
}
