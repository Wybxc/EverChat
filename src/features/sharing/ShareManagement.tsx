import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ManagedShare } from '../../../shared/sharing/types';
import { api } from '../../platform/api';
import { shareUrl } from './ShareDialog';
import { Modal, ModalTitle } from '../../components/Modal';

export default function ShareManagement({ active }: { active: boolean }) {
  const client = useQueryClient(),
    [busy, setBusy] = useState<string>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [link, setLink] = useState(''),
    [deleting, setDeleting] = useState<ManagedShare>();
  const cancel = useRef<HTMLButtonElement>(null);
  const query = useInfiniteQuery({
    queryKey: ['shares'],
    initialPageParam: null as string | null,
    enabled: active,
    queryFn: ({ pageParam, signal }) =>
      api<{ shares: ManagedShare[]; cursor: string | null }>(
        `/shares${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
    getNextPageParam: (page) => page.cursor ?? undefined,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    const changed = () => void client.invalidateQueries({ queryKey: ['shares'] });
    window.addEventListener('everchat:shares-changed', changed);
    return () => window.removeEventListener('everchat:shares-changed', changed);
  }, [client]);
  const perform = async (id: string, action: () => Promise<void>) => {
    setBusy(id);
    setError('');
    setNotice('');
    setLink('');
    try {
      await action();
      await client.invalidateQueries({ queryKey: ['shares'] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败，请重试。');
    } finally {
      setBusy(undefined);
    }
  };
  const copy = async (id: string) => {
    const result = await api<{ share: ManagedShare; secret: string }>(`/shares/${id}/link`);
    const url = shareUrl(result.share.id, result.secret);
    try {
      await navigator.clipboard.writeText(url);
      setNotice('分享链接已复制。');
    } catch {
      setLink(url);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">只读分享</h2>
        <Button
          variant="ghost"
          disabled={Boolean(busy) || query.isFetching}
          onClick={() => void query.refetch()}
        >
          刷新
        </Button>
      </div>
      {(error || query.error) && (
        <p role="alert" className="text-sm">
          {error || query.error?.message}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {link && (
        <Input
          aria-label="只读分享链接"
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在读取…
        </p>
      ) : query.data?.pages.every((page) => !page.shares.length) ? (
        <p className="text-sm text-muted-foreground">暂无分享。可在对话菜单中创建。</p>
      ) : (
        query.data?.pages
          .flatMap((page) => page.shares)
          .map((share) => (
            <div
              key={share.id}
              data-share-id={share.id}
              className="space-y-2 border-b border-border py-3 last:border-0"
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="min-w-0 break-words text-sm font-medium">{share.title}</h3>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {share.status === 'active' ? '' : '已失效'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {new Date(share.createdAt).toLocaleString()} · {share.messageCount} 条消息
                {share.expiresAt
                  ? ` · ${new Date(share.expiresAt).toLocaleString()} 到期自动删除`
                  : ' · 永久'}
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="ghost"
                  disabled={Boolean(busy) || share.status !== 'active'}
                  onClick={() => void perform(share.id, () => copy(share.id))}
                >
                  复制
                </Button>
                <Button variant="ghost" disabled={Boolean(busy)} onClick={() => setDeleting(share)}>
                  删除分享
                </Button>
              </div>
            </div>
          ))
      )}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          更多分享
        </Button>
      )}
      {deleting && (
        <Modal
          open
          alert
          busy={Boolean(busy)}
          initialFocus={cancel}
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
        >
          <div className="max-w-sm space-y-4 p-5">
            <ModalTitle>删除分享</ModalTitle>
            <p className="text-sm">
              删除「{deleting.title}」？链接将立即失效，并清除分享快照。接收者已保存的内容无法收回。
            </p>
            {error && (
              <p role="alert" className="text-sm">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                ref={cancel}
                variant="secondary"
                disabled={Boolean(busy)}
                onClick={() => setDeleting(undefined)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={Boolean(busy)}
                onClick={() =>
                  void perform(deleting.id, async () => {
                    await api(`/shares/${deleting.id}`, 'DELETE');
                    setDeleting(undefined);
                    setNotice('分享已删除。');
                  })
                }
              >
                确认删除
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
