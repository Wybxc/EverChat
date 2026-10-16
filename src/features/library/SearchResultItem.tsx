import { Command as CommandPrimitive } from 'cmdk';
import type { ReactNode } from 'react';

/** cmdk controls selection; the anchor preserves browser new-tab and copy-link behavior. */
export function SearchResultItem({
  value,
  href,
  open,
  children,
}: {
  value: string;
  href: string;
  open: () => void;
  children: ReactNode;
}) {
  return (
    <CommandPrimitive.Item
      value={value}
      onSelect={open}
      className="rounded-lg data-[selected=true]:bg-accent"
    >
      <a
        href={href}
        tabIndex={-1}
        className="block min-h-11 min-w-0 rounded-lg px-3 py-2 text-sm hover:bg-accent focus-visible:outline-2"
        onClick={(event) => {
          event.stopPropagation();
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          open();
        }}
      >
        {children}
      </a>
    </CommandPrimitive.Item>
  );
}
