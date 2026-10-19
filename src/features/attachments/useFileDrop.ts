import { t } from './locales';
import { useEffect, useRef, useState } from 'react';

export function isFileDrag(transfer: Pick<DataTransfer, 'types'> | null) {
  return Boolean(transfer && Array.from(transfer.types).includes('Files'));
}

// Listen above dialogs so an accidental file drop never navigates away from the
// app. Only the chat surface can accept it; text and link dragging stay native.
export function useFileDrop({
  canDrop,
  onFiles,
  onRejected,
}: {
  canDrop: () => boolean;
  onFiles: (files: File[]) => void;
  onRejected: (message: string) => void;
}) {
  const callbacks = useRef({ canDrop, onFiles, onRejected });
  callbacks.current = { canDrop, onFiles, onRejected };
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const validTarget = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest('[data-chat-drop-zone]')) &&
      callbacks.current.canDrop();
    const reset = () => {
      depth = 0;
      setDragging(false);
    };
    const enter = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      depth++;
      setDragging(validTarget(event.target));
    };
    const over = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      const allowed = validTarget(event.target);
      if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
      setDragging(allowed);
    };
    const leave = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      const allowed = validTarget(event.target);
      reset();
      if (!allowed || !event.dataTransfer) return;
      const items = Array.from(event.dataTransfer.items);
      const directory = items.some((item) => item.webkitGetAsEntry?.()?.isDirectory);
      const files = items.length
        ? items
            .filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null)
        : Array.from(event.dataTransfer.files);
      if (directory) callbacks.current.onRejected(t(($) => $.noFolders));
      if (files.length) callbacks.current.onFiles(files);
    };
    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', drop, true);
    window.addEventListener('dragend', reset, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', drop, true);
      window.removeEventListener('dragend', reset, true);
      window.removeEventListener('blur', reset);
    };
  }, []);
  return dragging;
}
