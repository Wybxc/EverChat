import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import type { PublicShare, ShareBlock, SharePage } from '../../../shared/sharing/types';
import { shareIdPattern, shareSecretPattern } from '../../../shared/sharing/types';
import { useThemeMode } from '../../platform/theme';
import { ShareContent } from './ShareContent';

function PublicSharePage() {
  const [theme, chooseTheme] = useThemeMode();
  const [share, setShare] = useState<PublicShare>();
  const [blocks, setBlocks] = useState<ShareBlock[]>([]),
    [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  const [reload, setReload] = useState(0),
    version = useRef(0);
  const id = location.pathname.split('/')[2] ?? '',
    token = location.hash.slice(1);
  const request = async <T,>(page?: number, signal?: AbortSignal): Promise<T> => {
    if (!shareIdPattern.test(id) || !shareSecretPattern.test(token))
      throw new Error('链接不可用。');
    let response: Response;
    try {
      response = await fetch(
        `/public/shares/${id}${page === undefined ? '' : `/messages?cursor=${page}`}`,
        {
          credentials: 'omit',
          cache: 'no-store',
          headers: { Authorization: `Bearer ${token}` },
          signal,
          redirect: 'error',
        },
      );
    } catch {
      throw new Error('无法连接，请联网后重试。');
    }
    if (!response.ok)
      throw new Error(response.status === 404 ? '链接不可用。' : '暂时无法读取，请稍后重试。');
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error('暂时无法读取，请稍后重试。');
    }
  };
  useEffect(() => {
    const controller = new AbortController(),
      current = ++version.current;
    setBusy(true);
    setError('');
    setShare(undefined);
    setBlocks([]);
    setCursor(null);
    void request<{ share: PublicShare; page: SharePage }>(undefined, controller.signal)
      .then((result) => {
        if (current !== version.current) return;
        setShare(result.share);
        setBlocks(result.page.blocks);
        setCursor(result.page.cursor);
        document.title = `${result.share.title} · EverChat`;
      })
      .catch((failure) => {
        if (!controller.signal.aborted && current === version.current)
          setError(failure instanceof Error ? failure.message : '暂时无法读取。');
      })
      .finally(() => {
        if (current === version.current) setBusy(false);
      });
    return () => {
      version.current++;
      controller.abort();
    };
  }, [reload, id, token]);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') setReload((value) => value + 1);
    };
    const hash = () => setReload((value) => value + 1);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', check);
    window.addEventListener('hashchange', hash);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pageshow', check);
      window.removeEventListener('hashchange', hash);
    };
  }, []);
  const more = async () => {
    if (cursor === null || busy) return;
    const current = version.current;
    setBusy(true);
    setError('');
    try {
      const result = await request<SharePage>(cursor);
      if (current === version.current) {
        setBlocks((previous) => [...previous, ...result.blocks]);
        setCursor(result.cursor);
      }
    } catch (failure) {
      if (current === version.current) {
        setError(failure instanceof Error ? failure.message : '暂时无法读取。');
        setShare(undefined);
        setBlocks([]);
      }
    } finally {
      if (current === version.current) setBusy(false);
    }
  };
  return (
    <div className="h-dvh overflow-y-auto bg-background text-foreground">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-background/95 px-4 py-3 backdrop-blur">
        <span className="font-semibold">EverChat</span>
        <NativeSelect
          aria-label="颜色模式"
          value={theme}
          onChange={(event) => chooseTheme(event.target.value as typeof theme)}
        >
          <option value="system">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </NativeSelect>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-4 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6">
        {share && (
          <>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold break-words">{share.title}</h1>
              <p className="text-xs text-muted-foreground">
                只读快照 · {share.messageCount} 条消息
                {share.omittedAttachments > 0 ? ' · 不含附件' : ''}
              </p>
            </div>
            <ShareContent blocks={blocks} />
          </>
        )}
        {error && (
          <div role="alert" className="space-y-3">
            <p>{error}</p>
            <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>
              重新读取
            </Button>
          </div>
        )}
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取…
          </p>
        ) : (
          cursor !== null &&
          share && (
            <Button variant="secondary" onClick={() => void more()}>
              继续阅读
            </Button>
          )
        )}
      </main>
    </div>
  );
}
export function start() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PublicSharePage />
    </StrictMode>,
  );
}
