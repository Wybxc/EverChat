import { useEffect, useState } from 'react';
import type { DocumentPart } from '../../../shared/attachments/documents';
import type { ImagePart } from '../../../shared/attachments/images';
import { read } from '../../platform/storage';
import { deletedAt, writeChatCache as write } from './cache';

export function useChatDraft(selected: string | null) {
  const [draft, setDraft] = useState('');
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
    setDraft(saved.text);
    setDraftImages(saved.images ?? []);
    setDraftFiles(saved.files ?? []);
  }, [selected]);
  const updateDraft = (text: string) => {
    setDraft(text);
    write(`draft:${selected ?? 'new'}`, {
      text,
      images: draftImages,
      files: draftFiles,
    });
  };
  const removeImage = (id: string) => {
    const images = draftImages.filter((image) => image.attachmentId !== id);
    setDraftImages(images);
    write(`draft:${selected ?? 'new'}`, { text: draft, images, files: draftFiles });
  };
  const removeDocument = (id: string) => {
    const files = draftFiles.filter((file) => file.attachmentId !== id);
    setDraftFiles(files);
    write(`draft:${selected ?? 'new'}`, { text: draft, images: draftImages, files });
  };
  return {
    draft,
    setDraft,
    draftFiles,
    setDraftFiles,
    draftImages,
    setDraftImages,
    updateDraft,
    removeImage,
    removeDocument,
  };
}
