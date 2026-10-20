import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { PublicShare, ShareBlock, SharedSnapshot } from '../../../shared/sharing/types';
import { shareIdPattern, shareSecretPattern } from '../../../shared/sharing/types';
import { LanguageControl } from '../../platform/i18n/LanguageControl';
import {
  UiError,
  type UiMessage,
  errorMessage,
  renderUiMessage,
  uiMessage,
} from '../../platform/i18n/messages';
import { pageI18n } from '../../platform/i18n/react';
import { useThemeMode } from '../../platform/theme';
import './locales';
import { ShareContent } from './ShareContent';

function PublicSharePage() {
  const { t } = useTranslation('sharing', { useSuspense: false });

  const [theme, chooseTheme] = useThemeMode();
  const [share, setShare] = useState<PublicShare>();
  const [blocks, setBlocks] = useState<ShareBlock[]>([]);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState<UiMessage>('');
  const [reload, setReload] = useState(0),
    version = useRef(0);
  const id = location.pathname.split('/')[2] ?? '',
    token = location.hash.slice(1);
  const request = async (signal: AbortSignal): Promise<SharedSnapshot> => {
    if (!shareIdPattern.test(id) || !shareSecretPattern.test(token))
      throw new UiError(uiMessage('sharing', 'unavailable'));
    let response: Response;
    try {
      response = await fetch(`/public/shares/${id}`, {
        credentials: 'omit',
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
        signal,
        redirect: 'error',
      });
    } catch {
      throw new UiError(uiMessage('sharing', 'connectionFailed'));
    }
    if (!response.ok)
      throw new UiError(
        uiMessage('sharing', response.status === 404 ? 'unavailable' : 'readFailed'),
      );
    try {
      return (await response.json()) as SharedSnapshot;
    } catch {
      throw new UiError(uiMessage('sharing', 'readFailed'));
    }
  };
  useEffect(() => {
    const controller = new AbortController(),
      current = ++version.current;
    setBusy(true);
    setError('');
    setShare(undefined);
    setBlocks([]);
    void request(controller.signal)
      .then((result) => {
        if (current !== version.current) return;
        if (result.share.expiresAt && result.share.expiresAt <= Date.now())
          throw new UiError(uiMessage('sharing', 'unavailable'));
        setShare(result.share);
        setBlocks(result.page.blocks);
        document.title = `${result.share.title} · EverChat`;
      })
      .catch((failure) => {
        if (!controller.signal.aborted && current === version.current)
          setError(errorMessage(failure, uiMessage('sharing', 'readFailedShort')));
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
    if (!share?.expiresAt) return;
    const expiresAt = share.expiresAt;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = expiresAt - Date.now();
      if (remaining > 0) timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
      else {
        setShare(undefined);
        setBlocks([]);
        setError(uiMessage('sharing', 'unavailable'));
        document.title = 'EverChat';
      }
    };
    check();
    return () => clearTimeout(timer);
  }, [share]);
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') setReload((value) => value + 1);
    };
    const hash = () => setReload((value) => value + 1);
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) check();
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('pageshow', restored);
    window.addEventListener('hashchange', hash);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('pageshow', restored);
      window.removeEventListener('hashchange', hash);
    };
  }, []);
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 bg-background/95 px-4 py-3 backdrop-blur">
        <span className="font-semibold">EverChat</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <LanguageControl compact />
          <NativeSelect
            aria-label={t(($) => $.theme)}
            value={theme}
            onChange={(event) => chooseTheme(event.target.value as typeof theme)}
          >
            <option value="system">{t(($) => $.system)}</option>
            <option value="light">{t(($) => $.light)}</option>
            <option value="dark">{t(($) => $.dark)}</option>
          </NativeSelect>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[49rem] space-y-6 px-4 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {share && (
          <>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold break-words">{share.title}</h1>
              <p className="text-xs text-muted-foreground">
                {t(($) => $.snapshotCount, { count: share.messageCount })}
                {share.omittedAttachments > 0 ? t(($) => $.noAttachments) : ''}
              </p>
            </div>
            <ShareContent blocks={blocks} />
          </>
        )}
        {error && (
          <div role="alert" className="space-y-3">
            <p>{renderUiMessage(error)}</p>
            <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>
              {t(($) => $.reload)}
            </Button>
          </div>
        )}
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {t(($) => $.loading)}
          </p>
        )}
      </main>
    </div>
  );
}
export function start() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nextProvider i18n={pageI18n}>
        <PublicSharePage />
      </I18nextProvider>
    </StrictMode>,
  );
}
