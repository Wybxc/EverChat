import { NativeSelect } from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '@/components/ui/attachment';
import { Download, FileText, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { selectedDocumentText, type DocumentPart } from '../../../shared/attachments/documents';
import { attachmentUrl } from '../../../shared/attachments/files';
import { Modal, ModalTitle } from '../../components/Modal';
import { api } from '../../platform/api';
import { formatNumber } from '../../platform/i18n/format';
import {
  errorMessage,
  renderUiMessage,
  uiMessage,
  type UiMessage,
} from '../../platform/i18n/messages';
import './locales';
import { PdfSelection } from './PdfSelection';

export function DocumentPreviews({
  conversationId,
  files,
  remove,
  onChange,
  budgetFor,
  toolsSupported = true,
}: {
  conversationId: string;
  files: DocumentPart[];
  remove?: (id: string) => void;
  onChange?: (file: DocumentPart) => void;
  toolsSupported?: boolean;
  budgetFor?: (file: DocumentPart) => number | undefined;
}) {
  const { t } = useTranslation('attachments', { useSuspense: false });

  const [preview, setPreview] = useState<DocumentPart | null>(null),
    [text, setText] = useState(''),
    [error, setError] = useState<UiMessage>(''),
    [loading, setLoading] = useState(false);
  const [original, setOriginal] = useState<DocumentPart | null>(null),
    [pageOffsets, setPageOffsets] = useState<number[] | undefined>();
  const title = useId();
  const [offsets, setOffsets] = useState([0]),
    [nextOffset, setNextOffset] = useState<number | null>(null);
  const offset = offsets.at(-1)!;
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
    setNextOffset(null);
    if (!preview.pdf) {
      void api<{ state: string; text: string; hasMore: boolean; nextOffset: number }>(
        `/conversations/${conversationId}/attachments/${preview.attachmentId}/document/page?offset=${offset}`,
        'GET',
        undefined,
        abort.signal,
      )
        .then((page) => {
          if (abort.signal.aborted) return;
          if (page.state !== 'available') throw new Error(t(($) => $.readFailed));
          setText(page.text);
          setNextOffset(page.hasMore ? page.nextOffset : null);
        })
        .catch((error) => {
          if (!abort.signal.aborted)
            setError(errorMessage(error, uiMessage('attachments', 'readFailed')));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
      return () => abort.abort();
    }
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
            setError(errorMessage(error, uiMessage('attachments', 'readFailed')));
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [preview, conversationId, offset, t]);
  if (!files.length) return null;
  return (
    <>
      <AttachmentGroup
        role="list"
        className="gap-2"
        aria-label={remove ? t(($) => $.draftFiles) : t(($) => $.messageFiles)}
      >
        {files.map((file) => (
          <Attachment key={file.attachmentId} role="listitem" size="sm" className="max-w-72">
            <AttachmentMedia>
              <FileText />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
              {file.pdf && (
                <AttachmentDescription>
                  {file.selection ? t(($) => $.selected) : t(($) => $.fullText)} · ≈
                  {formatNumber(file.tokens)}
                </AttachmentDescription>
              )}
            </AttachmentContent>
            <AttachmentTrigger
              type="button"
              aria-label={t(($) => $.preview, { name: file.name })}
              onClick={() => {
                setOffsets([0]);
                setPreview(file);
              }}
            />
            {(remove || onChange) && (
              <AttachmentActions>
                {remove && (
                  <AttachmentAction
                    variant="ghost"
                    size="icon"
                    type="button"
                    aria-label={t(($) => $.remove, { name: file.name })}
                    onClick={() => remove?.(file.attachmentId)}
                  >
                    <X className="h-[0.8125rem] w-[0.8125rem]" />
                  </AttachmentAction>
                )}
              </AttachmentActions>
            )}
          </Attachment>
        ))}
      </AttachmentGroup>
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
              {onChange && (
                <NativeSelect
                  size="sm"
                  className="w-auto"
                  aria-label={t(($) => $.inputMode, { name: preview.name })}
                  value={preview.inputMode ?? 'auto'}
                  onChange={(event) => {
                    const file = {
                      ...preview,
                      inputMode: event.currentTarget.value as DocumentPart['inputMode'],
                    };
                    onChange(file);
                    setPreview(file);
                  }}
                >
                  <option value="auto">{t(($) => $.modeAuto)}</option>
                  <option value="inline">{t(($) => $.modeInline)}</option>
                  <option value="on_demand" disabled={!toolsSupported}>
                    {t(($) => $.modeOnDemand)}
                  </option>
                </NativeSelect>
              )}
              <Button
                variant="ghost"
                size="icon"
                nativeButton={false}
                render={
                  <a
                    aria-label={t(($) => $.downloadFile)}
                    href={attachmentUrl(conversationId, preview.attachmentId)}
                    download={preview.name}
                  />
                }
              >
                <Download className="h-[1rem] w-[1rem]" />
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
                  onChange({
                    ...file,
                    ...(preview.inputMode ? { inputMode: preview.inputMode } : {}),
                  });
                  setPreview(null);
                }}
              />
            ) : (
              <div className="min-h-0 overflow-auto p-4">
                {loading ? (
                  <p role="status">{t(($) => $.loading)}</p>
                ) : error ? (
                  <p role="alert">{renderUiMessage(error)}</p>
                ) : (
                  <pre className="font-mono text-sm whitespace-pre-wrap break-words">
                    {selectedDocumentText(text, preview.selection?.ranges)}
                  </pre>
                )}
              </div>
            )}
            {!preview.pdf && (offsets.length > 1 || nextOffset !== null) && (
              <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loading || offsets.length < 2}
                  onClick={() => setOffsets((current) => current.slice(0, -1))}
                >
                  {t(($) => $.previousPage)}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loading || nextOffset === null}
                  onClick={() => {
                    if (nextOffset !== null) setOffsets((current) => [...current, nextOffset]);
                  }}
                >
                  {t(($) => $.nextPage)}
                </Button>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
