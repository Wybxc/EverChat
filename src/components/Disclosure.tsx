import { createContext, useContext, useRef, useState, type ReactNode } from 'react';

const DisclosureMemory = createContext<Map<string, boolean> | null>(null);

// A keyed scope retains view state across branch changes, without persisting it as settings.
export function DisclosureScope({ children }: { children: ReactNode }) {
  const [memory] = useState(() => new Map<string, boolean>());
  return <DisclosureMemory.Provider value={memory}>{children}</DisclosureMemory.Provider>;
}

export function Disclosure({
  children,
  title,
  stateKey,
  defaultOpen = false,
  open,
  forceOpen = false,
  onOpenChange,
  className = '',
  testId,
  id,
}: {
  children: ReactNode;
  title: ReactNode;
  stateKey?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  forceOpen?: boolean;
  className?: string;
  testId?: string;
  id?: string;
}) {
  const memory = useContext(DisclosureMemory);
  const [localOpen, setLocalOpen] = useState(() =>
    stateKey ? (memory?.get(stateKey) ?? defaultOpen) : defaultOpen,
  );
  const summary = useRef<HTMLElement>(null),
    body = useRef<HTMLDivElement>(null);
  return (
    <details
      id={id}
      data-testid={testId}
      className={`compact-disclosure ${className}`}
      open={forceOpen || (open ?? localOpen)}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (forceOpen && !next) {
          event.currentTarget.open = true;
          return;
        }
        if (!next && body.current?.contains(document.activeElement))
          summary.current?.focus({ preventScroll: true });
        if (stateKey) memory?.set(stateKey, next);
        setLocalOpen(next);
        onOpenChange?.(next);
      }}
    >
      <summary ref={summary} className="disclosure-title text-sm font-medium">
        {title}
      </summary>
      <div ref={body} className="disclosure-content">
        {children}
      </div>
    </details>
  );
}
