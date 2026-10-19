import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandList } from '@/components/ui/command';
import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationInfo } from '../../../shared/conversation/types';
import type { SearchResult } from '../../../shared/search/query';
import { normalizeSearch } from '../../../shared/search/query';
import { conversationUrl } from '../../app/useConversationRoute';
import { Modal, ModalTitle } from '../../components/Modal';
import { type UiMessage, renderUiMessage } from '../../platform/i18n/messages';
import { LibrarySearch } from './LibrarySearch';
import './locales';
import { SearchHighlight } from './SearchHighlight';
import { SearchResultItem } from './SearchResultItem';

export function GlobalSearch({
  conversations,
  loading,
  error,
  retry,
  close,
  restoreFocus,
  select,
  openResult,
}: {
  conversations: ConversationInfo[];
  loading: boolean;
  error: UiMessage;
  retry: () => void;
  close: () => void;
  restoreFocus: () => void;
  select: (id: string) => void;
  openResult: (result: SearchResult, query: string) => void;
}) {
  const { t } = useTranslation('library', { useSuspense: false });

  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const titles = conversations.filter((item) =>
    normalizeSearch(item.title).includes(normalizeSearch(query)),
  );
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      initialFocus={input}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        restoreFocus();
      }}
      onEscapeKeyDown={(event) => {
        if (event.isComposing || event.keyCode === 229) event.preventDefault();
      }}
    >
      <div
        className="search-dialog flex min-h-0 flex-col gap-0 overflow-hidden p-0"
        data-testid="global-search"
      >
        <ModalTitle className="sr-only">{t(($) => $.globalSearch)}</ModalTitle>
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-3 right-3 z-10 size-11 shrink-0"
          aria-label={t(($) => $.closeSearch)}
          onClick={close}
        >
          <X />
        </Button>
        <Command
          label={t(($) => $.searchChats)}
          shouldFilter={false}
          vimBindings={false}
          className="min-h-0 flex-1 rounded-none! p-0"
          onKeyDown={(event) => {
            const button = event.target instanceof Element ? event.target.closest('button') : null;
            if (
              !event.defaultPrevented &&
              !event.nativeEvent.isComposing &&
              event.key === 'Enter' &&
              button
            ) {
              event.preventDefault();
              button.click();
            }
          }}
        >
          <div className="w-full shrink-0 p-3 pr-16">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 [&_[data-slot=input-group]]:h-11!">
                <CommandInput
                  ref={input}
                  id="global-search-input"
                  value={query}
                  onValueChange={setQuery}
                  maxLength={200}
                  placeholder={t(($) => $.searchPlaceholder)}
                />
              </div>
            </div>
          </div>
          <CommandList
            className="min-h-0 max-h-none flex-1 overscroll-contain px-3 pb-6 sm:px-5"
            label={t(($) => $.searchResults)}
          >
            <div className="mx-auto max-w-3xl">
              <CommandGroup heading={query.trim() ? t(($) => $.titles) : t(($) => $.recentChats)}>
                {titles.map((item) => (
                  <SearchResultItem
                    key={item.id}
                    value={`title:${item.id}`}
                    href={conversationUrl(item.id)}
                    open={() => select(item.id)}
                  >
                    <span className="block truncate">
                      <SearchHighlight text={item.title} query={query} />
                    </span>
                  </SearchResultItem>
                ))}
                {loading && (
                  <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                    {t(($) => $.loadingChats)}
                  </p>
                )}
                {error && (
                  <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs">
                    <span>{renderUiMessage(error)}</span>
                    <Button variant="ghost" onClick={retry}>
                      {t(($) => $.retry)}
                    </Button>
                  </div>
                )}
                {!titles.length && !loading && !error && (
                  <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                    {query.trim() ? t(($) => $.noTitleMatches) : t(($) => $.noChats)}
                  </p>
                )}
              </CommandGroup>
              {query.trim() && <LibrarySearch query={query} open={openResult} />}
            </div>
          </CommandList>
        </Command>
      </div>
    </Modal>
  );
}
