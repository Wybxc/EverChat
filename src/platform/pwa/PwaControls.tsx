import { useTranslation } from 'react-i18next';
import { pwaMessage } from './locales';
import { useState, useSyncExternalStore } from 'react';
import { Download, RefreshCw, Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Modal, ModalTitle } from '../../components/Modal';
import {
  applyPwaChange,
  checkPwaUpdate,
  dismissPwaError,
  installPwa,
  pwaSnapshot,
  subscribePwa,
} from './controller';

export function PwaSettings() {
  const { t } = useTranslation('pwa', { useSuspense: false });

  const state = useSyncExternalStore(subscribePwa, pwaSnapshot);
  const [repair, setRepair] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copyFailed' | ''>('');
  return (
    <section aria-label={t(($) => $.application)} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">EverChat</span>
        <span className="break-all text-xs text-muted-foreground" data-testid="app-version">
          {state.version}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {!state.installed && state.canInstall && (
          <Button variant="secondary" type="button" onClick={() => void installPwa()}>
            <Download className="size-4" />
            {t(($) => $.install)}
          </Button>
        )}
        {state.supported && (
          <>
            <Button
              variant="secondary"
              type="button"
              disabled={state.pending || state.installing || state.preparing || state.repairing}
              onClick={() => void checkPwaUpdate()}
            >
              {state.checking || state.installing ? <Spinner /> : <RefreshCw className="size-4" />}
              {state.installing
                ? t(($) => $.preparingResources)
                : state.checking
                  ? t(($) => $.checking)
                  : state.pending
                    ? t(($) => $.stillChecking)
                    : t(($) => $.check)}
            </Button>
            {state.available && (
              <Button
                type="button"
                disabled={state.preparing || state.repairing}
                onClick={() => void applyPwaChange('update')}
              >
                {t(($) => $.update)}
              </Button>
            )}
            <Button
              variant="ghost"
              type="button"
              disabled={state.preparing || state.pending || state.repairing}
              onClick={() => setRepair(true)}
            >
              <Wrench className="size-4" />
              {state.repairing ? t(($) => $.preparingRepair) : t(($) => $.repairCache)}
            </Button>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {state.installed
          ? t(($) => $.installed)
          : !state.canInstall
            ? t(($) => $.installHint)
            : null}
        {state.supported
          ? state.available
            ? t(($) => $.newVersion)
            : state.ready
              ? t(($) => $.offlineReady)
              : t(($) => $.offlineNotReady)
          : null}
      </p>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {pwaMessage(state.error)}
        </p>
      )}
      {state.diagnostic && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t(($) => $.diagnostics)}</summary>
          <pre className="my-2 max-h-48 overflow-auto whitespace-pre-wrap break-all select-text">
            {JSON.stringify(state.diagnostic, null, 2)}
          </pre>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(JSON.stringify(state.diagnostic, null, 2)).then(
                () => setCopyStatus('copied'),
                () => setCopyStatus('copyFailed'),
              );
            }}
          >
            {t(($) => $.copyDiagnostics)}
          </Button>
          <span role="status">{copyStatus ? t(($) => $[copyStatus]) : ''}</span>
        </details>
      )}
      <Modal alert open={repair} onOpenChange={setRepair}>
        <div className="w-full max-w-sm space-y-4 p-5">
          <ModalTitle>{t(($) => $.repairCache)}</ModalTitle>
          <p className="text-sm">{t(($) => $.repairHint)}</p>
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => setRepair(false)}>
              {t(($) => $.cancel)}
            </Button>
            <Button
              onClick={() => {
                setRepair(false);
                void applyPwaChange('repair');
              }}
            >
              {t(($) => $.repairReload)}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
export function PwaNotice() {
  const { t } = useTranslation('pwa', { useSuspense: false });

  const state = useSyncExternalStore(subscribePwa, pwaSnapshot);
  const [dismissed, setDismissed] = useState(false);
  if (state.preparing)
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center gap-2 bg-background/95"
        role="status"
      >
        <Spinner />
        {t(($) => $.updating)}
      </div>
    );
  const error = state.noticeError ? state.error : '';
  if (!error && (!state.available || dismissed)) return null;
  return (
    <div
      className="fixed right-3 bottom-3 left-3 z-[90] mx-auto flex max-w-lg flex-wrap items-center gap-2 rounded-xl border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
      role={error ? 'alert' : 'status'}
      data-testid="pwa-notice"
    >
      <span className="min-w-0 flex-1">
        {error ? t(($) => $[error]) : t(($) => $.versionReady)}
      </span>
      {state.resourceError ? (
        <Button
          size="sm"
          disabled={state.repairing || state.pending}
          onClick={() => void applyPwaChange('repair')}
        >
          {t(($) => $.repair)}
        </Button>
      ) : (
        state.available && (
          <Button
            size="sm"
            disabled={state.repairing}
            onClick={() => void applyPwaChange('update')}
          >
            {t(($) => $.updateShort)}
          </Button>
        )
      )}
      <Button
        size="sm"
        aria-label={error ? t(($) => $.closeNotice) : undefined}
        variant="ghost"
        onClick={() => {
          setDismissed(true);
          dismissPwaError();
        }}
      >
        {error ? <X className="size-4" aria-hidden="true" /> : t(($) => $.later)}
      </Button>
    </div>
  );
}
