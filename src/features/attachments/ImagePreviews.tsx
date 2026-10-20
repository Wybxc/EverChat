import { useTranslation } from 'react-i18next';
import './locales';
import { Modal, ModalTitle } from '../../components/Modal';
import { Button } from '@/components/ui/button';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTrigger,
} from '@/components/ui/attachment';
import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { attachmentUrl } from '../../../shared/attachments/files';
import type { ImagePart } from '../../../shared/attachments/images';

export function ImagePreviews({
  conversationId,
  images,
  remove,
}: {
  conversationId: string;
  images: ImagePart[];
  remove?: (id: string) => void;
}) {
  const { t } = useTranslation('attachments', { useSuspense: false });

  const [preview, setPreview] = useState<ImagePart | null>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const title = useId();
  useEffect(() => {
    setPreview(null);
    setFailed(new Set());
  }, [conversationId]);
  useEffect(() => {
    const online = () => setFailed(new Set<string>());
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, []);
  if (!images.length) return null;
  return (
    <>
      <AttachmentGroup
        className="gap-2"
        role="group"
        aria-label={remove ? t(($) => $.draftImages) : t(($) => $.messageImages)}
      >
        {images.map((image) => (
          <Attachment
            size="sm"
            orientation="vertical"
            state={failed.has(image.attachmentId) ? 'error' : 'done'}
            key={image.attachmentId}
            className="min-w-0"
          >
            <AttachmentTrigger
              type="button"
              aria-label={t(($) => $.preview, { name: image.name })}
              onClick={() => setPreview(image)}
            />
            <AttachmentMedia variant="image" className="[&_img]:object-contain">
              {failed.has(image.attachmentId) ? (
                <span className="block p-3 text-xs">{t(($) => $.imageMissing)}</span>
              ) : (
                <img
                  src={attachmentUrl(conversationId, image.attachmentId)}
                  alt={image.name}
                  loading="lazy"
                  onError={() => setFailed((current) => new Set(current).add(image.attachmentId))}
                />
              )}
            </AttachmentMedia>
            {remove && (
              <AttachmentActions>
                <AttachmentAction
                  variant="secondary"
                  size="icon"
                  type="button"
                  aria-label={t(($) => $.remove, { name: image.name })}
                  onClick={() => remove(image.attachmentId)}
                >
                  <X className="h-[0.8125rem] w-[0.8125rem]" />
                </AttachmentAction>
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
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-4">
              <ModalTitle id={title} className="truncate font-medium">
                {preview.name}
              </ModalTitle>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label={t(($) => $.closeImage)}
                onClick={() => setPreview(null)}
              >
                <X className="h-[1.125rem] w-[1.125rem]" />
              </Button>
            </div>
            <div className="min-h-0 overflow-auto p-4">
              {failed.has(preview.attachmentId) ? (
                <p role="alert">{t(($) => $.imageMissing)}</p>
              ) : (
                <img
                  onError={() => setFailed((current) => new Set(current).add(preview.attachmentId))}
                  src={attachmentUrl(conversationId, preview.attachmentId)}
                  alt={preview.name}
                  className="mx-auto max-h-[70dvh] max-w-full object-contain"
                />
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
