import { Button } from '@/components/ui/button';
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteList,
  AutocompleteGroup,
  AutocompleteLabel,
  AutocompleteCollection,
} from '@/components/ui/autocomplete';
import { X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationInfo } from '../../../shared/conversation/types';
import type { SearchResult } from '../../../shared/search/query';
import { normalizeSearch } from '../../../shared/search/query';
import { conversationUrl } from '../../app/useConversationRoute';
import { Modal, ModalTitle } from '../../components/Modal';
import { type UiMessage, renderUiMessage } from '../../platform/i18n/messages';
import { LibrarySearch } from './LibrarySearch';
import { useLibrarySearch } from './useLibrarySearch';
import './locales';
import { SearchHighlight } from './SearchHighlight';
import { SearchResultItem } from './SearchResultItem';

type SearchChoice = { id: string; title: string; href: string; result?: SearchResult };

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
  const body = useLibrarySearch(query);
  const titles = useMemo(
    () =>
      conversations.filter((item) => normalizeSearch(item.title).includes(normalizeSearch(query))),
    [conversations, query],
  );
  const groups = [
    {
      id: 'titles',
      label: query.trim() ? t(($) => $.titles) : t(($) => $.recentChats),
      items: titles.map((item): SearchChoice => ({
        id: item.id,
        title: item.title,
        href: conversationUrl(item.id),
      })),
    },
    ...(query.trim()
      ? [
          {
            id: 'body',
            label: t(($) => $.bodyAndReasoning),
            items: body.results.map((result): SearchChoice => ({
              id: `body:${result.conversationId}:${result.messageId}:${result.field}`,
              title: result.title,
              href: conversationUrl(result.conversationId, result.messageId),
              result,
            })),
          },
        ]
      : []),
  ];
  return (
    <Modal
      open
      onOpenChange={(open, details) => {
        const event = details.event;
        if (
          details.reason === 'escape-key' &&
          event instanceof KeyboardEvent &&
          (event.isComposing || event.keyCode === 229)
        )
          details.cancel();
        else if (!open) close();
      }}
      initialFocus={input}
      finalFocus={() => {
        restoreFocus();
        return false;
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
        <Autocomplete
          items={groups}
          mode="none"
          inline
          open
          autoHighlight="always"
          keepHighlight
          loopFocus={false}
          value={query}
          itemToStringValue={(item: SearchChoice) => item.title}
          onValueChange={(value, details) => {
            if (details.reason === 'item-press') details.cancel();
            else setQuery(value);
          }}
        >
          <div className="w-full shrink-0 p-3 pr-16">
            <AutocompleteInput
              ref={input}
              id="global-search-input"
              aria-label={t(($) => $.searchChats)}
              maxLength={200}
              placeholder={t(($) => $.searchPlaceholder)}
            />
          </div>
          <div
            data-slot="search-results"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-6 sm:px-5"
          >
            <div className="mx-auto max-w-3xl">
              <AutocompleteList aria-label={t(($) => $.searchResults)}>
                {(group: (typeof groups)[number]) => (
                  <AutocompleteGroup key={group.id} items={group.items} className="p-1">
                    <AutocompleteLabel>{group.label}</AutocompleteLabel>
                    <AutocompleteCollection>
                      {(item: SearchChoice) => (
                        <SearchResultItem
                          key={item.id}
                          value={item}
                          href={item.href}
                          open={() =>
                            item.result ? openResult(item.result, body.debounced) : select(item.id)
                          }
                        >
                          <span
                            className={
                              item.result ? 'block truncate text-xs font-medium' : 'block truncate'
                            }
                          >
                            <SearchHighlight text={item.title} query={query} />
                            {item.result && (
                              <>
                                {' '}
                                ·{' '}
                                {item.result.field === 'reasoning'
                                  ? t(($) => $.reasoning)
                                  : t(($) => $.body)}
                              </>
                            )}
                          </span>
                          {item.result && (
                            <span className="mt-1 block line-clamp-3 break-words text-xs text-muted-foreground">
                              <SearchHighlight text={item.result.excerpt} query={query} />
                            </span>
                          )}
                        </SearchResultItem>
                      )}
                    </AutocompleteCollection>
                  </AutocompleteGroup>
                )}
              </AutocompleteList>
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
              {query.trim() && <LibrarySearch state={body} />}
            </div>
          </div>
        </Autocomplete>
      </div>
    </Modal>
  );
}
