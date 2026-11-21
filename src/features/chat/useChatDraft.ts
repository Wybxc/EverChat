import { useEffect, useState } from 'react';
import type { DocumentPart } from '../../../shared/attachments/documents';
import type { ImagePart } from '../../../shared/attachments/images';
import { read } from '../../platform/storage';
import { deletedAt, writeChatCache as write } from './cache';

function createDraftTextStore() {
  let value = '';
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(text: string) {
      if (text === value) return;
      value = text;
      for (const listener of listeners) listener();
    },
  };
}

export type DraftTextStore = ReturnType<typeof createDraftTextStore>;

export function useChatDraft(selected: string | null) {
  const [draftText] = useState(createDraftTextStore);
  const [draftFiles, setDraftFiles] = useState<DocumentPart[]>([]);
  const [draftImages, setDraftImages] = useState<ImagePart[]>([]);
  useEffect(() => {
    const saved: {
      text: string;
      images?: ImagePart[];
      files?: DocumentPart[];
    } =
      selected && deletedAt(selected)
        ? { text: '' }
        : read(`draft:${selected ?? 'new'}`, { text: '' });
    draftText.set(saved.text);
    setDraftImages(saved.images ?? []);
    setDraftFiles(saved.files ?? []);
  }, [selected, draftText]);
  const updateDraft = (text: string) => {
    draftText.set(text);
    write(`draft:${selected ?? 'new'}`, {
      text,
      images: draftImages,
      files: draftFiles,
    });
  };
  const removeImage = (id: string) => {
    const images = draftImages.filter((image) => image.attachmentId !== id);
    setDraftImages(images);
    write(`draft:${selected ?? 'new'}`, {
      text: draftText.getSnapshot(),
      images,
      files: draftFiles,
    });
  };
  const removeDocument = (id: string) => {
    const files = draftFiles.filter((file) => file.attachmentId !== id);
    setDraftFiles(files);
    write(`draft:${selected ?? 'new'}`, {
      text: draftText.getSnapshot(),
      images: draftImages,
      files,
    });
  };
  const updateDocument = (file: DocumentPart) => {
    const files = draftFiles.map((item) => (item.attachmentId === file.attachmentId ? file : item));
    setDraftFiles(files);
    write(`draft:${selected ?? 'new'}`, {
      text: draftText.getSnapshot(),
      images: draftImages,
      files,
    });
  };
  return {
    draftText,
    setDraft: draftText.set,
    draftFiles,
    setDraftFiles,
    draftImages,
    setDraftImages,
    updateDraft,
    removeImage,
    removeDocument,
    updateDocument,
  };
}
