import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { attachmentUrl } from '../shared/attachments';
import type { ImagePart } from '../shared/images';

export function ImagePreviews({ conversationId, images, remove }: { conversationId: string; images: ImagePart[]; remove?: (id: string) => void }) {
  const [preview, setPreview] = useState<ImagePart | null>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const dialog = useRef<HTMLDialogElement>(null), title = useId();
  useEffect(() => { if (preview) dialog.current?.showModal(); }, [preview]);
  useEffect(() => { setPreview(null); setFailed(new Set()); }, [conversationId]);
  useEffect(() => {
    const online = () => setFailed(new Set<string>());
    window.addEventListener('online', online); return () => window.removeEventListener('online', online);
  }, []);
  if (!images.length) return null;
  return <><div className="flex flex-wrap gap-2" role="group" aria-label={remove ? '待发送图片' : '消息图片'}>
    {images.map((image) => <div key={image.attachmentId} className="relative rounded-box border border-base-content/50 bg-base-100 p-1">
      <button type="button" className="block max-w-32 overflow-hidden rounded-field" aria-label={`预览 ${image.name}`} onClick={() => setPreview(image)}>
        {failed.has(image.attachmentId) ? <span className="block p-3 text-xs">图片不可用</span> : <img src={attachmentUrl(conversationId, image.attachmentId)} alt={image.name} loading="lazy" className="h-24 w-28 object-contain" onError={() => setFailed((current) => new Set(current).add(image.attachmentId))} />}
      </button>
      {remove && <button type="button" className="btn btn-square btn-xs absolute right-0 top-0" aria-label={`移除 ${image.name}`} onClick={() => remove(image.attachmentId)}><X size={13} /></button>}
    </div>)}
  </div>{preview && createPortal(<dialog ref={dialog} className="modal" aria-labelledby={title} onSubmit={(event) => event.stopPropagation()} onClose={() => setPreview(null)}>
    <div className="modal-box flex max-h-[90dvh] max-w-4xl flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-base-content/30 p-4"><h2 id={title} className="truncate font-medium">{preview.name}</h2><button type="button" className="btn btn-ghost btn-square btn-sm" aria-label="关闭图片预览" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <div className="min-h-0 overflow-auto p-4">{failed.has(preview.attachmentId) ? <p role="alert">图片不可用</p> : <img onError={() => setFailed((current) => new Set(current).add(preview.attachmentId))} src={attachmentUrl(conversationId, preview.attachmentId)} alt={preview.name} className="mx-auto max-h-[70dvh] max-w-full object-contain" />}</div>
    </div><form method="dialog" className="modal-backdrop"><button>关闭</button></form>
  </dialog>, document.body)}</>;
}
