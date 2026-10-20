import type { ComponentProps, ReactNode, Ref } from 'react';
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group';

/** Presentation only: the caller owns the one draft, input handlers and submission lifecycle. */
export function ChatComposer({
  onSubmit,
  attachments,
  upload,
  input,
  toolbar,
  toolbarRef,
  compact,
  notices,
}: {
  onSubmit: ComponentProps<'form'>['onSubmit'];
  attachments: ReactNode;
  upload: ReactNode;
  input: ReactNode;
  toolbar: ReactNode;
  toolbarRef: Ref<HTMLDivElement>;
  compact: boolean;
  notices: ReactNode;
}) {
  return (
    <form onSubmit={onSubmit}>
      <InputGroup data-testid="chat-composer" className="chat-composer">
        {(attachments || upload) && (
          <InputGroupAddon align="block-start" className="flex-col items-stretch gap-1 p-0">
            {attachments}
            {upload}
          </InputGroupAddon>
        )}
        {input}
        <InputGroupAddon
          align="block-end"
          ref={toolbarRef}
          className="composer-toolbar mt-1 min-w-0 gap-1 p-0"
          data-testid="composer-toolbar"
          data-compact={compact}
        >
          {toolbar}
        </InputGroupAddon>
      </InputGroup>
      {notices}
    </form>
  );
}
