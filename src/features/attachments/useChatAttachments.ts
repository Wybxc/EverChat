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
import { conversationSettingsSchema } from '../../../shared/conversation/settings';
import {
  type ConversationInfo,
  type ConversationSettings,
} from '../../../shared/conversation/types';
import { canAttemptCapability } from '../../../shared/models/metadata';
import type { ChatModel } from '../../../shared/models/types';
import type { SessionInfo } from '../../../shared/auth/types';
import { api } from '../../platform/api';
import { read } from '../../platform/storage';
import { prepareAttachment, uploadAttachment } from './attachment-upload';
import { prepareChatImage } from './chat-image';
import { preparePdf } from './pdf-loader';
import { writeChatCache } from '../chat/cache';
import type { useChatDraft } from '../chat/useChatDraft';

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
  setError: (error: string) => void;
}) {
  const { draft, revisionOf, draftImages, draftFiles, setDraftImages, setDraftFiles } = chatDraft;
  const imageUpload = useRef<{ origin: string | null; controller: AbortController } | null>(null);
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
  const addUploads = async (inputFiles: File[], kind: 'image' | 'file') => {
    if (!inputFiles.length || isBusy() || imageUpload.current) return;
    if (!navigator.onLine || !session?.attachmentsConfigured) {
      setError('附件上传需要联网并配置文件存储。');
      return;
    }
    if (selected && !currentConversation) {
      setError('请等待对话同步后再添加附件。');
      return;
    }
    if (kind === 'image' && !canAttemptCapability(selectedModel?.metadata, 'imageInput')) {
      setError('请先选择支持图片的视觉模型。');
      return;
    }
    if (
      inputFiles.length + (kind === 'image' ? draftImages.length : draftFiles.length) >
      (kind === 'image' ? MAX_MESSAGE_IMAGES : MAX_MESSAGE_DOCUMENTS)
    ) {
      setError(
        kind === 'image' ? '每条消息最多添加 4 张图片。' : '每条消息最多添加 4 个文本文件。',
      );
      return;
    }
    const origin = selected,
      controller = new AbortController(),
      operation = { origin, controller };
    imageUpload.current = operation;
    setImageProgress({ name: inputFiles[0].name, percent: 0, kind });
    setError('');
    let conversation = currentConversation;
    const uploadedImages: ImagePart[] = [],
      uploadedFiles: DocumentPart[] = [],
      registered: string[] = [];
    try {
      const preparedFiles: {
        file: File;
        input: Awaited<ReturnType<typeof prepareAttachment>>;
        pdf?: PDFExtraction;
      }[] = [];
      for (const file of inputFiles) {
        setImageProgress({ name: file.name, percent: 0, kind });
        const mediaType = fileMediaType(file.name);
        if (
          kind === 'file' &&
          (!v.safeParse(documentMediaTypeSchema, mediaType).success ||
            !file.size ||
            (mediaType !== 'application/pdf' && file.size > MAX_DOCUMENT_BYTES))
        )
          throw new Error('请选择 PDF 或不超过 128 KiB 的 UTF-8 文本、代码、CSV 文件。');
        const prepared = kind === 'image' ? await prepareChatImage(file, controller.signal) : file;
        const input = await prepareAttachment(prepared, controller.signal);
        const pdf =
          kind === 'file' && input.mediaType === 'application/pdf'
            ? await preparePdf(prepared, input.sha256, controller.signal, (page, pages) =>
                setImageProgress({
                  name: `正在提取 ${prepared.name} · ${page}/${pages}`,
                  percent: Math.round((page / pages) * 100),
                  kind,
                }),
              )
            : undefined;
        preparedFiles.push({ file: prepared, input, pdf });
      }
      if (!conversation) {
        const parameters = v.safeParse(conversationSettingsSchema, conversationSettings);
        if (!parameters.success) throw new Error('请先修正会话参数，再添加附件。');
        conversation = {
          id: crypto.randomUUID(),
          title: (draft.trim() || inputFiles[0].name).slice(0, 26),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          pinned: false,
          archived: false,
        };
        await api(
          '/conversations',
          'POST',
          { id: conversation.id, title: conversation.title },
          controller.signal,
        );
        await api(
          `/conversations/${conversation.id}/settings`,
          'PUT',
          parameters.output,
          controller.signal,
        );
      }
      for (const { file: prepared, input, pdf } of preparedFiles) {
        setImageProgress({ name: prepared.name, percent: 0, kind });
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
          setImageProgress({ name: `正在解析 ${prepared.name}`, percent: 100, kind });
          uploadedFiles.push(
            await api<DocumentPart>(
              `/conversations/${conversation.id}/attachments/${saved.id}/document`,
              'POST',
              pdf,
              controller.signal,
            ),
          );
        }
      }
      controller.signal.throwIfAborted();
      if (selectedRef.current !== origin) throw new DOMException('已切换对话', 'AbortError');
      const savedDraft = read<{ text: string; revisionOf?: string }>(`draft:${origin ?? 'new'}`, {
        text: draft,
        revisionOf,
      });
      const images = [...draftImages, ...uploadedImages],
        files = [...draftFiles, ...uploadedFiles];
      if (!origin) resetNewTools();
      writeChatCache(`draft:${conversation.id}`, { ...savedDraft, images, files });
      setDraftImages(images);
      setDraftFiles(files);
      if (!origin) {
        writeChatCache('draft:new', { text: '' });
        select(conversation.id);
      }
      refreshLibrary();
    } catch (error) {
      if (conversation)
        for (const id of registered)
          await api(
            `/conversations/${conversation.id}/attachments/${id}`,
            'DELETE',
            undefined,
            AbortSignal.timeout(10_000),
          ).catch(() => {});
      if (selectedRef.current === origin && !controller.signal.aborted)
        setError(error instanceof Error ? error.message : '附件上传失败。');
    } finally {
      if (imageUpload.current === operation) {
        imageUpload.current = null;
        setImageProgress(null);
      }
    }
  };
  const addImages = (files: File[]) => addUploads(files, 'image');
  const addDocuments = (files: File[]) => addUploads(files, 'file');
  return { imageUpload, imageProgress, addImages, addDocuments };
}
