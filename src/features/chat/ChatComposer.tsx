import { useDeferredValue, useSyncExternalStore } from 'react';
import type { ComponentProps, ReactNode, Ref, RefObject } from 'react';
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group';
import type { DraftTextStore } from './useChatDraft';
import { useComposerSize } from './useComposerSize';
import { useContextPreview } from './useContextPreview';

type ContextPreview = ReturnType<typeof useContextPreview>;

export function ChatComposer({
  onSubmit,
  draftText,
  editor,
  context,
  attachments,
  upload,
  input,
  toolbar,
  toolbarRef,
  compact,
  notices,
}: {
  onSubmit: ComponentProps<'form'>['onSubmit'];
  draftText: DraftTextStore;
  editor: RefObject<HTMLTextAreaElement | null>;
  context: Omit<Parameters<typeof useContextPreview>[0], 'draft'>;
  attachments: (preview: ContextPreview) => ReactNode;
  upload: ReactNode;
  input: (draft: string) => ReactNode;
  toolbar: (draft: string, preview: ContextPreview) => ReactNode;
  toolbarRef: Ref<HTMLDivElement>;
  compact: boolean;
  notices: (preview: ContextPreview) => ReactNode;
}) {
  // Only the composer subscribes to each keystroke. Submission still reads the current draft.
  const draft = useSyncExternalStore(draftText.subscribe, draftText.getSnapshot);
  const previewDraft = useDeferredValue(draft);
  const preview = useContextPreview({ ...context, draft: previewDraft });
  const attachmentContent = attachments(preview);
  useComposerSize(editor, draft);
  return (
    <form onSubmit={onSubmit}>
      <InputGroup data-testid="chat-composer" className="chat-composer">
        {(attachmentContent || upload) && (
          <InputGroupAddon align="block-start" className="flex-col items-stretch gap-1 p-0">
            {attachmentContent}
            {upload}
          </InputGroupAddon>
        )}
        {input(draft)}
        <InputGroupAddon
          align="block-end"
          tone="default"
          ref={toolbarRef}
          className="composer-toolbar mt-1 min-w-0 gap-1 p-0"
          data-testid="composer-toolbar"
          data-compact={compact}
        >
          {toolbar(draft, preview)}
        </InputGroupAddon>
      </InputGroup>
      {notices(preview)}
    </form>
  );
}
