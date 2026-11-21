import { useTranslation } from 'react-i18next';
import * as v from 'valibot';
import { messageArtifacts } from '../../../shared/conversation/content';
import { isActive } from '../../../shared/conversation/message-state';
import { attachmentUrl, bytesLabel } from '../../../shared/attachments/files';
import { imageMediaTypeSchema, type ImagePart } from '../../../shared/attachments/images';
import type { Message } from '../../../shared/conversation/types';
import { ImagePreviews } from '../attachments/ImagePreviews';
import './locales';

export function ProviderArtifacts({
  message,
  conversationId,
}: {
  message: Message;
  conversationId: string;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const artifacts = messageArtifacts(message);
  const images = artifacts.flatMap((part): ImagePart[] => {
    const mediaType = v.safeParse(imageMediaTypeSchema, part.mediaType);
    return mediaType.success ? [{ ...part, type: 'image', mediaType: mediaType.output }] : [];
  });
  const preview = isActive(message) ? message.streamState?.previewArtifact : undefined;
  if (!artifacts.length && !preview) return null;
  return (
    <section className="space-y-2" aria-label={t(($) => $.providerArtifacts)}>
      {preview && (
        <figure className="w-fit max-w-full space-y-1">
          <img
            className="max-h-48 max-w-full rounded-md border object-contain"
            alt={t(($) => $.providerImagePreview)}
            src={attachmentUrl(conversationId, preview.attachmentId)}
          />
          <figcaption className="text-xs text-muted-foreground">
            {t(($) => $.providerImagePreview)}
          </figcaption>
        </figure>
      )}
      <ImagePreviews conversationId={conversationId} images={images} />
      {!!artifacts.length && (
        <ul className="space-y-1 text-xs">
          {artifacts.map((part) => (
            <li key={part.attachmentId} className="break-all">
              <a
                className="underline underline-offset-2"
                href={attachmentUrl(conversationId, part.attachmentId)}
                download={part.name}
              >
                {part.name}
              </a>
              <span className="ml-2 text-muted-foreground">{bytesLabel(part.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
