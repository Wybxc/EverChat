import { formatNumber } from '../../platform/i18n/format';
import { useTranslation } from 'react-i18next';
import './locales';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import {
  estimateDocumentTokens,
  selectedDocumentText,
  type DocumentPart,
  type DocumentRange,
} from '../../../shared/attachments/documents';
import { pageRanges } from '../../../shared/attachments/pdf-selection';
import { api } from '../../platform/api';

export function PdfSelection({
  conversationId,
  file,
  original,
  text,
  pageOffsets,
  budget,
  onApply,
}: {
  conversationId: string;
  file: DocumentPart;
  original: DocumentPart;
  text: string;
  pageOffsets?: number[];
  budget?: number;
  onApply: (file: DocumentPart) => void;
}) {
  const { t } = useTranslation('attachments', { useSuspense: false });

  const [mode, setMode] = useState(file.selection ? 'fragment' : 'all'),
    [pages, setPages] = useState('1');
  const [fragment, setFragment] = useState<DocumentRange[]>(
    file.selection?.ranges ?? [{ start: 0, end: text.length }],
  );
  const source = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = source.current;
    if (mode !== 'fragment' || !field) return;
    const update = () => {
      if (document.activeElement !== field) return;
      const { selectionStart: start, selectionEnd: end } = field;
      if (end > start)
        setFragment((previous) =>
          previous.length === 1 && previous[0].start === start && previous[0].end === end
            ? previous
            : [{ start, end }],
        );
    };
    // Native events also cover read-only selection handles on mobile browsers.
    field.addEventListener('select', update);
    document.addEventListener('selectionchange', update);
    return () => {
      field.removeEventListener('select', update);
      document.removeEventListener('selectionchange', update);
    };
  }, [mode]);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  let ranges = mode === 'all' ? [{ start: 0, end: text.length }] : fragment,
    invalid = '';
  if (mode === 'pages') {
    try {
      ranges = pageRanges(pages, pageOffsets ?? [], text.length);
    } catch (failure) {
      invalid = (failure as Error).message;
    }
  }
  const selected = selectedDocumentText(text, ranges),
    tokens = estimateDocumentTokens(original, selected);
  const over = budget !== undefined && tokens > budget;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label={t(($) => $.pdfRange)}
            value={mode}
            onChange={(event) => {
              setMode(event.target.value);
              setError('');
            }}
          >
            <option value="all">{t(($) => $.fullText)}</option>
            <option value="pages" disabled={!pageOffsets}>
              {t(($) => $.choosePages)}
            </option>
            <option value="fragment">{t(($) => $.chooseExcerpt)}</option>
          </NativeSelect>
          {mode === 'pages' && (
            <Input
              aria-label={t(($) => $.sendPages)}
              placeholder="1-3, 5"
              className="min-w-32 flex-1"
              value={pages}
              onChange={(event) => setPages(event.target.value)}
            />
          )}
          {pageOffsets && budget !== undefined && (
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                let low = 0,
                  high = pageOffsets.length;
                while (low < high) {
                  const mid = Math.ceil((low + high) / 2);
                  if (
                    estimateDocumentTokens(
                      original,
                      text.slice(0, pageOffsets[mid] ?? text.length),
                    ) <= budget
                  )
                    low = mid;
                  else high = mid - 1;
                }
                if (!low) {
                  setMode('fragment');
                  setError(t(($) => $.firstPageOver));
                  return;
                }
                setPages(`1-${low}`);
                setMode('pages');
                setError('');
              }}
            >
              {t(($) => $.fitPages)}
            </Button>
          )}
        </div>
        <p
          className={`text-xs ${over ? 'text-destructive' : 'text-muted-foreground'}`}
          role="status"
        >
          {t(($) => $.pdfSummary, { count: file.pdf!.pages, tokens: formatNumber(tokens) })}
          {budget === undefined
            ? ''
            : t(($) => $.availableBudget, { tokens: formatNumber(budget) })}
        </p>
        {mode === 'fragment' && (
          <p className="text-xs text-muted-foreground">{t(($) => $.selectionHint)}</p>
        )}
        {(invalid || error) && (
          <p className="text-xs text-destructive" role="alert">
            {invalid || error}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-3">
        {mode === 'fragment' ? (
          <Textarea
            readOnly
            ref={source}
            aria-label={t(($) => $.pdfOriginal)}
            className="h-[min(50dvh,24rem)] min-h-32 w-full resize-none font-mono"
            style={{ fieldSizing: 'fixed' }}
            value={text}
          />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-sm">{selected}</pre>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">
          {over ? t(($) => $.overBudget) : t(($) => $.retainedHint)}
        </span>
        <Button
          type="button"
          disabled={busy || Boolean(invalid)}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const result = await api<DocumentPart>(
                `/conversations/${conversationId}/attachments/${file.attachmentId}/document/selection`,
                'POST',
                { ranges },
                undefined,
                60_000,
              );
              onApply(result);
            } catch (failure) {
              setError((failure as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t(($) => $.saving) : t(($) => $.useSelection)}
        </Button>
      </div>
    </div>
  );
}
