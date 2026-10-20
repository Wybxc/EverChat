import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderFailure } from '../../../shared/providers/failure';
import { Disclosure } from '../../components/Disclosure';
import { type UiMessage, renderUiMessage, uiMessage } from '../../platform/i18n/messages';
import { failureDiagnosticText, failureEntries } from './failure-details';
import './locales';

export function ProviderFailureView({
  summary,
  failure,
  stateKey,
  showSummary = true,
  onSettings,
}: {
  summary: UiMessage;
  failure?: ProviderFailure;
  stateKey: string;
  showSummary?: boolean;
  onSettings?: () => void;
}) {
  const { t } = useTranslation('providers', { useSuspense: false });

  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState<UiMessage>('');
  return (
    <div
      data-testid="provider-failure"
      className="mt-3 rounded-lg bg-destructive/5 px-3 py-2 text-xs leading-6 text-foreground"
    >
      {showSummary && (
        <p role="alert" className="font-medium">
          {renderUiMessage(summary)}
        </p>
      )}
      {failure && (
        <Disclosure title={t(($) => $.errorDetails)} stateKey={stateKey} className="mt-1">
          <dl className="space-y-1">
            {failureEntries(failure).map(([label, value]) => (
              <div key={label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="whitespace-pre-wrap break-words">{value}</dd>
              </div>
            ))}
          </dl>
          {failure.responseBody && (
            <div className="mt-2 min-w-0">
              <p className="text-muted-foreground">{t(($) => $.failureResponseBody)}</p>
              <pre
                data-testid="provider-response-body"
                aria-label={t(($) => $.failureResponseBody)}
                tabIndex={0}
                className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs leading-5"
              >
                {failure.responseBody}
              </pre>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={async () => {
                setCopyError('');
                try {
                  await navigator.clipboard.writeText(
                    failureDiagnosticText(renderUiMessage(summary), failure),
                  );
                  setCopied(true);
                } catch {
                  setCopyError(uiMessage('providers', 'copyFailed'));
                }
              }}
            >
              {copied ? t(($) => $.copied) : t(($) => $.copyDiagnostics)}
            </Button>
            {onSettings && (
              <Button type="button" variant="ghost" size="sm" onClick={onSettings}>
                {t(($) => $.providerSettings)}
              </Button>
            )}
          </div>
          {copyError && <p role="alert">{renderUiMessage(copyError)}</p>}
        </Disclosure>
      )}
    </div>
  );
}
