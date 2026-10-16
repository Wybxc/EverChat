import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { completeSignOut, resumeAccess } from '../platform/auth';
import { Brand } from './Brand';
import { ThemeControl } from './ThemeControl';
import type { SessionStatus } from './useSession';

export function AccessGate({
  status,
  error,
  onRetry,
  logoutUrl,
}: {
  logoutUrl: string;
  status: SessionStatus;
  error: string;
  onRetry: () => void;
}) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return (
    <main className="flex min-h-dvh flex-col bg-background">
      <header className="flex items-start justify-between px-7 py-7 sm:px-12">
        <Brand />
        <ThemeControl />
      </header>
      <section className="mx-auto flex w-full max-w-md flex-1 flex-col items-start justify-center gap-5 px-7 pb-20">
        {status === 'loading' ? (
          <Spinner />
        ) : (
          <>
            <p role="alert" className="text-sm text-foreground">
              {status === 'denied'
                ? '当前账号没有访问权限。'
                : status === 'unavailable'
                  ? error || '暂时无法连接。'
                  : status === 'signed-out'
                    ? error || '本地记录已清除。联网后可完成退出。'
                    : '请登录以继续。'}
            </p>
            {status === 'unavailable' && (
              <Button variant="secondary" onClick={onRetry}>
                重新连接
              </Button>
            )}
            {status === 'signed-out' ? (
              <Button
                disabled={!error && !online}
                onClick={error ? onRetry : () => completeSignOut(logoutUrl)}
              >
                {error ? '重试清除本地记录' : '完成退出'}
              </Button>
            ) : (
              <Button
                onClick={status === 'denied' ? () => completeSignOut(logoutUrl) : resumeAccess}
              >
                {status === 'denied' ? '切换账号' : '重新登录'}
              </Button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
