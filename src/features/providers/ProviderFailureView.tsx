import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Disclosure } from '../../components/Disclosure';
import {
  failureDiagnosticText,
  failureEntries,
  type ProviderFailure,
} from '../../../shared/providers/failure';

export function ProviderFailureView({
  summary,
  failure,
  stateKey,
  showSummary = true,
  onSettings,
}: {
  summary: string;
  failure?: ProviderFailure;
  stateKey: string;
  showSummary?: boolean;
  onSettings?: () => void;
}) {
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState('');
  return (
    <div
      data-testid="provider-failure"
      className="mt-3 rounded-lg bg-destructive/5 px-3 py-2 text-xs leading-6 text-foreground"
    >
      {showSummary && (
        <p role="alert" className="font-medium">
          {summary}
        </p>
      )}
      {failure && (
        <Disclosure title="错误详情" stateKey={stateKey} className="mt-1">
          <dl className="space-y-1">
            {failureEntries(failure).map(([label, value]) => (
              <div key={label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="whitespace-pre-wrap break-words">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={async () => {
                setCopyError('');
                try {
                  await navigator.clipboard.writeText(failureDiagnosticText(summary, failure));
                  setCopied(true);
                } catch {
                  setCopyError('复制失败，请重试。');
                }
              }}
            >
              {copied ? '已复制' : '复制诊断信息'}
            </Button>
            {onSettings && (
              <Button type="button" variant="ghost" size="sm" onClick={onSettings}>
                供应商设置
              </Button>
            )}
          </div>
          {copyError && <p role="alert">{copyError}</p>}
        </Disclosure>
      )}
    </div>
  );
}
