import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ConversationInfo } from '../../../shared/conversation/types';
import type { SearchResult } from '../../../shared/search/query';
import { conversationUrl } from '../../app/useConversationRoute';
import { Modal, ModalTitle } from '../../components/Modal';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandList, CommandGroup } from '@/components/ui/command';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LibrarySearch } from './LibrarySearch';
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
  error: string;
  retry: () => void;
  close: () => void;
  restoreFocus: () => void;
  select: (id: string) => void;
  openResult: (result: SearchResult, query: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const titles = conversations.filter(
    (item) =>
      Boolean(item.archived) === archived &&
      item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
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
        className="inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0"
        data-testid="global-search"
      >
        <ModalTitle className="sr-only">全局搜索</ModalTitle>
        <Command
          label="搜索对话"
          shouldFilter={false}
          vimBindings={false}
          className="flex-1 rounded-none! p-0"
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
          <div className="mx-auto w-full max-w-3xl shrink-0 p-3 sm:p-5">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 [&_[data-slot=input-group]]:h-11!">
                <CommandInput
                  ref={input}
                  id="global-search-input"
                  value={query}
                  onValueChange={setQuery}
                  maxLength={200}
                  placeholder="搜索你的对话"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label="关闭全局搜索"
                onClick={close}
              >
                <X />
              </Button>
            </div>
            <Tabs
              value={archived ? 'archived' : 'active'}
              onValueChange={(value) => setArchived(value === 'archived')}
              className="mt-2"
            >
              <TabsList>
                <TabsTrigger value="active">对话</TabsTrigger>
                <TabsTrigger value="archived">归档</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <CommandList
            className="min-h-0 max-h-none flex-1 overscroll-contain px-3 pb-6 sm:px-5"
            label="搜索结果"
          >
            <div className="mx-auto max-w-3xl">
              <CommandGroup heading={query.trim() ? '标题' : '近期对话'}>
                {titles.map((item) => (
                  <SearchResultItem
                    key={item.id}
                    value={`title:${item.id}`}
                    href={conversationUrl(item.id)}
                    open={() => select(item.id)}
                  >
                    <span className="block truncate">{item.title}</span>
                  </SearchResultItem>
                ))}
                {loading && (
                  <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                    正在读取对话列表
                  </p>
                )}
                {error && (
                  <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs">
                    <span>{error}</span>
                    <Button variant="ghost" onClick={retry}>
                      重试
                    </Button>
                  </div>
                )}
                {!titles.length && !loading && !error && (
                  <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
                    {query.trim() ? '没有标题匹配' : '暂无对话'}
                  </p>
                )}
              </CommandGroup>
              {query.trim() && (
                <LibrarySearch query={query} archived={archived} open={openResult} />
              )}
            </div>
          </CommandList>
        </Command>
      </div>
    </Modal>
  );
}
