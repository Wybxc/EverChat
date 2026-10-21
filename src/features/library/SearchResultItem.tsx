import { AutocompleteItem } from '@/components/ui/autocomplete';
import type { ReactNode } from 'react';

/** Base UI handles keyboard selection; the anchor keeps native new-tab and copy-link actions. */
export function SearchResultItem({
  value,
  href,
  open,
  children,
}: {
  value: unknown;
  href: string;
  open: () => void;
  children: ReactNode;
}) {
  return (
    <AutocompleteItem value={value} onClick={open}>
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
    </AutocompleteItem>
  );
}
