import { formatNumber } from '../../platform/i18n/format';
import { useTranslation } from 'react-i18next';
import './locales';
import { Modal, ModalTitle } from '../../components/Modal';
import { Button } from '@/components/ui/button';
import { useEffect, useId, useState } from 'react';
import { Download, FileText, X } from 'lucide-react';
import { selectedDocumentText, type DocumentPart } from '../../../shared/attachments/documents';
import { PdfSelection } from './PdfSelection';
import { attachmentUrl } from '../../../shared/attachments/files';
import { api } from '../../platform/api';

export function DocumentPreviews({
  conversationId,
  files,
  remove,
  onChange,
  budgetFor,
}: {
  conversationId: string;
  files: DocumentPart[];
  remove?: (id: string) => void;
  onChange?: (file: DocumentPart) => void;
  budgetFor?: (file: DocumentPart) => number | undefined;
}) {
  const { t } = useTranslation('attachments', { useSuspense: false });

  const [preview, setPreview] = useState<DocumentPart | null>(null),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [original, setOriginal] = useState<DocumentPart | null>(null),
    [pageOffsets, setPageOffsets] = useState<number[] | undefined>();
  const title = useId();
  useEffect(() => {
    setPreview(null);
  }, [conversationId]);
  useEffect(() => {
    if (!preview) return;
    const abort = new AbortController();
    setLoading(true);
    setOriginal(null);
    setPageOffsets(undefined);
    setText('');
    setError('');
    void api<{ file: DocumentPart; text: string; pageOffsets?: number[] }>(
      `/conversations/${conversationId}/attachments/${preview.attachmentId}/document`,
      'GET',
      undefined,
      abort.signal,
      60_000,
    )
      .then(
        (saved) => {
          if (!abort.signal.aborted) {
            setText(saved.text);
            setOriginal(saved.file);
            setPageOffsets(saved.pageOffsets);
          }
        },
        (error) => {
          if (!abort.signal.aborted)
            setError(error instanceof Error ? error.message : t(($) => $.readFailed));
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [preview, conversationId]);
  if (!files.length) return null;
  return (
    <>
      <ul
        className="mb-2 divide-y divide-border max-w-full rounded-lg border border-border bg-background"
        aria-label={remove ? t(($) => $.draftFiles) : t(($) => $.messageFiles)}
      >
        {files.map((file) => (
          <li key={file.attachmentId} className="flex items-center gap-2 p-2">
            <FileText className="h-[1rem] w-[1rem]" />
            <Button
              variant="ghost"
              type="button"
              className="min-w-0 flex-1 justify-start"
              aria-label={t(($) => $.preview, { name: file.name })}
              onClick={() => setPreview(file)}
            >
              <span className="truncate">{file.name}</span>
              {file.pdf && (
                <span className="text-xs text-muted-foreground">
                  {file.selection ? t(($) => $.selected) : t(($) => $.fullText)} · ≈
                  {formatNumber(file.tokens)}
                </span>
              )}
            </Button>
            {remove && (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label={t(($) => $.remove, { name: file.name })}
                onClick={() => remove(file.attachmentId)}
              >
                <X className="h-[0.8125rem] w-[0.8125rem]" />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {preview && (
        <Modal
          open
          onOpenChange={(next) => {
            if (!next) setPreview(null);
          }}
          aria-labelledby={title}
          onSubmit={(event) => event.stopPropagation()}
        >
          <div className="w-full flex max-h-[90dvh] max-w-4xl flex-col overflow-hidden p-0">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-4">
              <ModalTitle id={title} className="min-w-0 flex-1 truncate font-medium">
                {preview.name}
              </ModalTitle>
              <Button variant="ghost" size="icon" asChild>
                <a
                  aria-label={t(($) => $.downloadFile)}
                  href={attachmentUrl(conversationId, preview.attachmentId)}
                  download={preview.name}
                >
                  <Download className="h-[1rem] w-[1rem]" />
                </a>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label={t(($) => $.closePreview)}
                onClick={() => setPreview(null)}
              >
                <X className="h-[1.125rem] w-[1.125rem]" />
              </Button>
            </div>
            {!loading && !error && original && preview.pdf && onChange ? (
              <PdfSelection
                conversationId={conversationId}
                file={preview}
                original={original}
                text={text}
                pageOffsets={pageOffsets}
                budget={budgetFor?.(preview)}
                onApply={(file) => {
                  onChange(file);
                  setPreview(null);
                }}
              />
            ) : (
              <div className="min-h-0 overflow-auto p-4">
                {loading ? (
                  <p role="status">{t(($) => $.loading)}</p>
                ) : error ? (
                  <p role="alert">{error}</p>
                ) : (
                  <pre className="font-mono text-sm whitespace-pre-wrap break-words">
                    {selectedDocumentText(text, preview.selection?.ranges)}
                  </pre>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
