import { useTranslation } from 'react-i18next';
import './locales';
import { Modal, ModalTitle } from '../../components/Modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { File, Trash2, X } from 'lucide-react';
import { attachmentUrl, bytesLabel, type Attachment } from '../../../shared/attachments/files';
import { api } from '../../platform/api';
import { prepareAttachment, uploadAttachment } from './attachment-upload';

export function AttachmentDialog({
  id,
  open,
  close,
}: {
  id: string;
  open: boolean;
  close: () => void;
}) {
  const { t } = useTranslation('attachments', { useSuspense: false });

  const picker = useRef<HTMLInputElement>(null),
    titleId = useId();
  const controller = useRef<AbortController | null>(null),
    client = useQueryClient();
  const [upload, setUpload] = useState<{ name: string; size: number; sent: number } | null>(null);
  const [error, setError] = useState(''),
    [removing, setRemoving] = useState<string | null>(null);
  const key = ['attachments', id];
  const files = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<Attachment[]>(`/conversations/${id}/attachments`, 'GET', undefined, signal),
    enabled: open,
    refetchInterval: open ? 3000 : false,
  });
  useEffect(() => () => controller.current?.abort(), []);
  const selectFiles = async (items: FileList | null) => {
    if (!items?.length || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setError('');
    try {
      for (const file of Array.from(items)) {
        setUpload({ name: file.name, size: file.size, sent: 0 });
        const input = await prepareAttachment(file, abort.signal);
        await uploadAttachment(id, input, file, abort.signal, (sent) =>
          setUpload({ name: file.name, size: file.size, sent }),
        );
        await client.invalidateQueries({ queryKey: key });
      }
    } catch (failure) {
      if (!abort.signal.aborted)
        setError(failure instanceof Error ? failure.message : t(($) => $.simpleUploadFailed));
    } finally {
      controller.current = null;
      setUpload(null);
      if (picker.current) picker.current.value = '';
      void client.invalidateQueries({ queryKey: key });
    }
  };
  const remove = async (file: Attachment) => {
    setError('');
    setRemoving(file.id);
    try {
      await api(`/conversations/${id}/attachments/${file.id}`, 'DELETE');
      await client.invalidateQueries({ queryKey: key });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t(($) => $.deleteFailed));
    } finally {
      setRemoving(null);
    }
  };
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      initialFocus={picker}
      aria-labelledby={titleId}
    >
      <div className="w-full flex max-h-[85dvh] max-w-xl flex-col overflow-hidden p-0">
        <div className="flex shrink-0 items-center justify-between gap-3 p-5">
          <ModalTitle id={titleId} className="text-lg font-semibold">
            {t(($) => $.files)}
          </ModalTitle>
          <div>
            <Button variant="ghost" size="icon" onClick={close} aria-label={t(($) => $.closeFiles)}>
              <X className="h-[1.125rem] w-[1.125rem]" />
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <label className="block space-y-2 text-sm">
            <span>{t(($) => $.upload)}</span>
            <Input
              ref={picker}
              type="file"
              multiple
              aria-label={t(($) => $.upload)}
              className="w-full"
              disabled={Boolean(upload) || !navigator.onLine}
              accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.pdf,.js,.jsx,.ts,.tsx,.py,.rs,.go,.c,.cpp,.h,.css,.json,.yaml,.yml,.toml,.sh"
              onChange={(event) => void selectFiles(event.currentTarget.files)}
            />
          </label>
          <p className="mt-2 text-xs text-muted-foreground">{t(($) => $.storageHint)}</p>
          {upload && (
            <div role="status" className="mt-4 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {upload.name} ·{' '}
                  {upload.sent === upload.size
                    ? t(($) => $.saving)
                    : `${Math.round((upload.sent / Math.max(1, upload.size)) * 100)}%`}
                </span>
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => controller.current?.abort()}
                >
                  {t(($) => $.cancelUpload)}
                </Button>
              </div>
              <progress
                className="progress-meter w-full"
                aria-label={t(($) => $.progress)}
                value={upload.sent}
                max={Math.max(1, upload.size)}
              />
            </div>
          )}
          {(error || files.error) && (
            <p role="alert" className="mt-4 text-sm">
              {error || files.error?.message}
            </p>
          )}
          {files.isPending ? (
            <p className="mt-5 text-sm">{t(($) => $.loading)}</p>
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {files.data?.map((file) => (
                <li
                  key={file.id}
                  className="flex items-center gap-3 py-3 [&>div:first-of-type]:flex-1"
                >
                  <File className="h-[1.25rem] w-[1.25rem]" />
                  <div className="min-w-0">
                    <p className="truncate text-sm">{file.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {bytesLabel(file.size)} ·{' '}
                      {file.status === 'ready'
                        ? t(($) => $.saved)
                        : file.status === 'uploading'
                          ? t(($) => $.uploading)
                          : file.status === 'failed'
                            ? t(($) => $.uploadError)
                            : t(($) => $.waiting)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {file.status === 'ready' && (
                      <a
                        className="inline-flex min-h-11 items-center rounded-lg px-3 hover:bg-muted "
                        href={attachmentUrl(id, file.id)}
                        download={file.name}
                      >
                        {t(($) => $.download)}
                      </a>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      aria-label={t(($) => $.deleteFile, { name: file.name })}
                      disabled={Boolean(removing) || !navigator.onLine}
                      onClick={() => void remove(file)}
                    >
                      <Trash2 className="h-[1rem] w-[1rem]" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {files.data?.length === 0 && (
            <p className="mt-5 text-sm text-muted-foreground">{t(($) => $.empty)}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
