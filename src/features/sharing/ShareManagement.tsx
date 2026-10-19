import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import type { ManagedShare } from '../../../shared/sharing/types';
import { api } from '../../platform/api';
import { ExpiryOptions, parseExpiry, shareUrl } from './ShareDialog';

const labels = { active: '有效', revoked: '已撤销', expired: '已过期', draft: '草稿' };
export default function ShareManagement({ active }: { active: boolean }) {
  const client = useQueryClient(),
    [busy, setBusy] = useState<string>(),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [link, setLink] = useState('');
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
  const copy = async (id: string, rotate = false) => {
    const result = await api<{ share: ManagedShare; secret: string }>(
      `/shares/${id}${rotate ? '' : '/link'}`,
      rotate ? 'PATCH' : 'GET',
      rotate ? { rotate: true } : undefined,
    );
    const url = shareUrl(result.share.id, result.secret);
    try {
      await navigator.clipboard.writeText(url);
      setNotice(rotate ? '新链接已复制，旧链接已失效。' : '分享链接已复制。');
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
                  {labels[share.status]}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {new Date(share.createdAt).toLocaleString()} · {share.messageCount} 条消息 ·{' '}
                {share.expiresAt ? `${new Date(share.expiresAt).toLocaleString()} 到期` : '永久'}
              </p>
              <div className="flex flex-wrap items-center gap-1">
                {share.status === 'active' ? (
                  <>
                    <Button
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onClick={() => void perform(share.id, () => copy(share.id))}
                    >
                      复制
                    </Button>
                    <NativeSelect
                      aria-label={`${share.title}的有效期`}
                      value=""
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        void perform(share.id, async () => {
                          await api(`/shares/${share.id}`, 'PATCH', {
                            expiry: parseExpiry(event.target.value),
                          });
                        })
                      }
                    >
                      <option value="" disabled>
                        修改有效期
                      </option>
                      <ExpiryOptions />
                    </NativeSelect>
                    <details>
                      <summary className="cursor-pointer px-2 py-1 text-sm">链接操作</summary>
                      <div className="flex flex-wrap gap-1 py-1">
                        <Button
                          variant="secondary"
                          disabled={Boolean(busy)}
                          onClick={() => void perform(share.id, () => copy(share.id, true))}
                        >
                          轮换链接，旧链接失效
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void perform(share.id, async () => {
                              await api(`/shares/${share.id}/revoke`, 'POST');
                            })
                          }
                        >
                          撤销分享
                        </Button>
                      </div>
                    </details>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void perform(share.id, async () => {
                        await api(`/shares/${share.id}`, 'DELETE');
                      })
                    }
                  >
                    清理快照
                  </Button>
                )}
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
      <p className="text-xs text-muted-foreground">
        撤销会停止后续读取；接收者已保存的内容无法收回。
      </p>
    </div>
  );
}
