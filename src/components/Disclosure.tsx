import {
  createContext,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

function createDisclosureMemory() {
  const values = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  return {
    values,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(key: string, value: boolean) {
      if (values.get(key) === value) return;
      values.set(key, value);
      listeners.forEach((listener) => listener());
    },
  };
}
const DisclosureMemory = createContext<ReturnType<typeof createDisclosureMemory> | null>(null);
const noSubscription = () => () => {};

export function useDisclosureState(stateKey?: string, defaultOpen = false) {
  const memory = useContext(DisclosureMemory);
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const snapshot = () => (stateKey ? (memory?.values.get(stateKey) ?? localOpen) : localOpen);
  const open = useSyncExternalStore(memory?.subscribe ?? noSubscription, snapshot, snapshot);
  const setOpen = (value: boolean) => {
    if (stateKey && memory) memory.set(stateKey, value);
    else setLocalOpen(value);
  };
  return [open, setOpen] as const;
}

export function useDisclosureController() {
  return useContext(DisclosureMemory)?.set;
}

// A keyed scope retains view state across branch changes, without persisting it as settings.
export function DisclosureScope({ children }: { children: ReactNode }) {
  const [memory] = useState(createDisclosureMemory);
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
  const [localOpen, setLocalOpen] = useDisclosureState(stateKey, defaultOpen);
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
