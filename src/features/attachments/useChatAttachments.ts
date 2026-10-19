import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import * as v from 'valibot';
import {
  documentMediaTypeSchema,
  MAX_DOCUMENT_BYTES,
  MAX_MESSAGE_DOCUMENTS,
  type DocumentPart,
} from '../../../shared/attachments/documents';
import { fileMediaType } from '../../../shared/attachments/files';
import { MAX_MESSAGE_IMAGES, type ImagePart } from '../../../shared/attachments/images';
import type { PDFExtraction } from '../../../shared/attachments/pdf';
import type { SessionInfo } from '../../../shared/auth/types';
import { conversationSettingsSchema } from '../../../shared/conversation/settings';
import {
  type ConversationInfo,
  type ConversationSettings,
} from '../../../shared/conversation/types';
import { canAttemptCapability } from '../../../shared/models/metadata';
import type { ChatModel } from '../../../shared/models/types';
import { api } from '../../platform/api';
import { errorMessage, UiError, uiMessage, type UiMessage } from '../../platform/i18n/messages';
import { read } from '../../platform/storage';
import { writeChatCache } from '../chat/cache';
import type { useChatDraft } from '../chat/useChatDraft';
import { prepareAttachment, uploadAttachment } from './attachment-upload';
import { prepareChatImage } from './chat-image';
import { t } from './locales';
import { preparePdf } from './pdf-loader';

export function useChatAttachments({
  selected,
  selectedRef,
  currentConversation,
  session,
  selectedModel,
  isBusy,
  chatDraft,
  conversationSettings,
  resetNewTools,
  select,
  refreshLibrary,
  setError,
}: {
  selected: string | null;
  selectedRef: RefObject<string | null>;
  currentConversation?: ConversationInfo;
  session: SessionInfo | null;
  selectedModel?: ChatModel;
  isBusy: () => boolean;
  chatDraft: ReturnType<typeof useChatDraft>;
  conversationSettings: ConversationSettings;
  resetNewTools: () => void;
  select: (id: string) => void;
  refreshLibrary: () => void;
  setError: (error: UiMessage) => void;
}) {
  const { draft, draftImages, draftFiles, setDraftImages, setDraftFiles } = chatDraft;
  const imageUpload = useRef<{ origin: string | null; controller: AbortController } | null>(null);
  const [failure, setFailure] = useState<{ id: string | null; message: UiMessage } | null>(null);
  useEffect(() => {
    setFailure((value) => (value?.id === selected ? value : null));
  }, [selected]);
  const [imageProgress, setImageProgress] = useState<{
    name: string;
    percent: number;
    kind: 'image' | 'file';
  } | null>(null);
  useEffect(() => {
    if (imageUpload.current && (imageUpload.current.origin !== selected || !session?.authenticated))
      imageUpload.current.controller.abort();
  }, [selected, session?.authenticated]);
  useEffect(() => () => imageUpload.current?.controller.abort(), []);
  const addUploads = async (inputFiles: File[], forcedKind?: 'image' | 'file') => {
    if (!inputFiles.length || isBusy() || imageUpload.current) return;
    if (!navigator.onLine || !session?.attachmentsConfigured) {
      setError(uiMessage('attachments', 'storageRequired'));
      return;
    }
    if (selected && !currentConversation) {
      setError(uiMessage('attachments', 'waitSync'));
      return;
    }
    const origin = selected,
      controller = new AbortController(),
      operation = { origin, controller };
    imageUpload.current = operation;
    const kindOf = (file: File) =>
      forcedKind ??
      ((file.type || fileMediaType(file.name))?.startsWith('image/') ? 'image' : 'file');
    setImageProgress({ name: inputFiles[0].name, percent: 0, kind: kindOf(inputFiles[0]) });
    setError('');
    setFailure(null);
    let conversation = currentConversation;
    let settingsSaved = Boolean(conversation);
    const uploadedImages: ImagePart[] = [],
      uploadedFiles: DocumentPart[] = [],
      registered: string[] = [],
      errors: UiMessage[] = [];
    const cleanup = async (id: string) => {
      if (conversation)
        await api(
          `/conversations/${conversation.id}/attachments/${id}`,
          'DELETE',
          undefined,
          AbortSignal.timeout(10_000),
        ).catch(() => {});
    };
    try {
      for (const file of inputFiles) {
        let registeredId: string | undefined;
        const kind = kindOf(file);
        try {
          controller.signal.throwIfAborted();
          if (kind === 'image' && !canAttemptCapability(selectedModel?.metadata, 'imageInput'))
            throw new UiError(uiMessage('attachments', 'visionRequired'));
          if (
            (kind === 'image'
              ? draftImages.length + uploadedImages.length
              : draftFiles.length + uploadedFiles.length) >=
            (kind === 'image' ? MAX_MESSAGE_IMAGES : MAX_MESSAGE_DOCUMENTS)
          )
            throw new UiError(
              uiMessage('attachments', kind === 'image' ? 'imageLimit' : 'documentLimit'),
            );
          setImageProgress({ name: file.name, percent: 0, kind });
          const mediaType = fileMediaType(file.name);
          if (
            kind === 'file' &&
            (!v.safeParse(documentMediaTypeSchema, mediaType).success ||
              !file.size ||
              (mediaType !== 'application/pdf' && file.size > MAX_DOCUMENT_BYTES))
          )
            throw new UiError(uiMessage('attachments', 'invalidDocument'));
          const prepared =
            kind === 'image' ? await prepareChatImage(file, controller.signal) : file;
          const input = await prepareAttachment(prepared, controller.signal);
          const pdf: PDFExtraction | undefined =
            kind === 'file' && input.mediaType === 'application/pdf'
              ? await preparePdf(prepared, input.sha256, controller.signal, (page, pages) =>
                  setImageProgress({
                    name: t(($) => $.extracting, { name: prepared.name, page, pages }),
                    percent: Math.round((page / pages) * 100),
                    kind,
                  }),
                )
              : undefined;
          controller.signal.throwIfAborted();
          if (selectedRef.current !== origin)
            throw new DOMException(
              t(($) => $.chatChanged),
              'AbortError',
            );
          if (!conversation) {
            const parameters = v.safeParse(conversationSettingsSchema, conversationSettings);
            if (!parameters.success)
              throw new UiError(uiMessage('attachments', 'settingsRequired'));
            const created: ConversationInfo = {
              id: crypto.randomUUID(),
              title: (draft.trim() || file.name).slice(0, 26),
              createdAt: Date.now(),
              updatedAt: Date.now(),
              pinned: false,
            };
            await api(
              '/conversations',
              'POST',
              { id: created.id, title: created.title },
              controller.signal,
            );
            conversation = created;
          }
          if (!settingsSaved) {
            const parameters = v.safeParse(conversationSettingsSchema, conversationSettings);
            if (!parameters.success)
              throw new UiError(uiMessage('attachments', 'settingsRequired'));
            await api(
              `/conversations/${conversation.id}/settings`,
              'PUT',
              parameters.output,
              controller.signal,
            );
            settingsSaved = true;
          }
          registeredId = input.id;
          registered.push(input.id);
          const saved = await uploadAttachment(
            conversation.id,
            input,
            prepared,
            controller.signal,
            (received) =>
              setImageProgress({
                name: prepared.name,
                percent: Math.round((received / input.size) * 100),
                kind,
              }),
          );
          if (kind === 'image')
            uploadedImages.push({
              type: 'image',
              attachmentId: saved.id,
              name: saved.name,
              sha256: saved.sha256,
              size: saved.size,
              mediaType: prepared.type as ImagePart['mediaType'],
            });
          else {
            setImageProgress({
              name: t(($) => $.parsing, { name: prepared.name }),
              percent: 100,
              kind,
            });
            uploadedFiles.push(
              await api<DocumentPart>(
                `/conversations/${conversation.id}/attachments/${saved.id}/document`,
                'POST',
                pdf
                  ? new Blob(
                      [
                        JSON.stringify({
                          sourceSha256: pdf.sourceSha256,
                          pdf: pdf.pdf,
                          pageOffsets: pdf.pageOffsets,
                        }) + '\n',
                        pdf.text,
                      ],
                      { type: 'application/vnd.everchat.pdf-text' },
                    )
                  : undefined,
                controller.signal,
                60_000,
              ),
            );
          }
        } catch (error) {
          if (controller.signal.aborted || selectedRef.current !== origin) throw error;
          if (registeredId) {
            await cleanup(registeredId);
            registered.splice(registered.indexOf(registeredId), 1);
          }
          errors.push(
            uiMessage('attachments', 'fileFailure', {
              name: file.name,
              error: errorMessage(error, uiMessage('attachments', 'uploadFailed')),
            }),
          );
        }
      }
      controller.signal.throwIfAborted();
      if (selectedRef.current !== origin)
        throw new DOMException(
          t(($) => $.chatChanged),
          'AbortError',
        );
      if (conversation && (uploadedImages.length || uploadedFiles.length)) {
        const savedDraft = read<{ text: string; images?: ImagePart[]; files?: DocumentPart[] }>(
          `draft:${origin ?? 'new'}`,
          { text: draft, images: draftImages, files: draftFiles },
        );
        const images = [...(savedDraft.images ?? []), ...uploadedImages],
          files = [...(savedDraft.files ?? []), ...uploadedFiles];
        if (!origin) resetNewTools();
        writeChatCache(`draft:${conversation.id}`, { ...savedDraft, images, files });
        setDraftImages(images);
        setDraftFiles(files);
        if (!origin) {
          writeChatCache('draft:new', { text: '' });
          select(conversation.id);
        }
        refreshLibrary();
      }
      if (errors.length)
        setFailure({
          id:
            conversation && (uploadedImages.length || uploadedFiles.length)
              ? conversation.id
              : origin,
          message: { join: errors, separator: '\n' },
        });
    } catch (error) {
      for (const id of registered) await cleanup(id);
      if (selectedRef.current === origin && !controller.signal.aborted)
        setError(errorMessage(error, uiMessage('attachments', 'uploadFailed')));
    } finally {
      if (imageUpload.current === operation) {
        imageUpload.current = null;
        setImageProgress(null);
      }
    }
  };
  const addImages = (files: File[]) => addUploads(files, 'image');
  const addDocuments = (files: File[]) => addUploads(files, 'file');
  const addFiles = (files: File[]) => addUploads(files);
  return {
    imageUpload,
    imageProgress,
    addImages,
    addDocuments,
    addFiles,
    attachmentError: failure?.id === selected ? failure.message : '',
    clearAttachmentError: () => setFailure(null),
  };
}
