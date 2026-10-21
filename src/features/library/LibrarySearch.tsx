import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from 'react-i18next';
import { errorMessage, renderUiMessage } from '../../platform/i18n/messages';
import type { useLibrarySearch } from './useLibrarySearch';
import './locales';

export function LibrarySearch({ state }: { state: ReturnType<typeof useLibrarySearch> }) {
  const { t } = useTranslation('library', { useSuspense: false });
  const { online, search, ready, pages } = state;
  return (
    <div className="space-y-2 pb-2">
      {!online ? (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {t(($) => $.searchNeedsNetwork)}
        </p>
      ) : !ready || search.isPending ? (
        <p role="status" className="px-3 text-xs">
          <Spinner aria-hidden="true" />
          {t(($) => $.searching)}
        </p>
      ) : null}
      {pages && !pages.some((page) => page.results.length) && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {t(($) => $.noBodyMatches)}
        </p>
      )}
      {pages?.some((page) => page.indexing) && (
        <p role="status" className="mt-2 px-3 text-xs text-muted-foreground">
          {t(($) => $.indexing)}
        </p>
      )}
      {pages?.at(-1)?.error && (
        <p role="alert" className="mt-2 px-3 text-xs">
          {pages.at(-1)!.error}
        </p>
      )}
      {search.error && ready && (
        <div role="alert" className="space-y-2 px-3 text-xs">
          <p>{renderUiMessage(errorMessage(search.error))}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void search.refetch();
            }}
          >
            {t(($) => $.searchAgain)}
          </Button>
        </div>
      )}
      {ready && search.hasNextPage && (
        <Button
          variant="ghost"
          type="button"
          className="mt-2 w-full"
          disabled={search.isFetchingNextPage || !online}
          onClick={() => {
            void search.fetchNextPage();
          }}
        >
          {search.isFetchingNextPage ? t(($) => $.loading) : t(($) => $.loadMore)}
        </Button>
      )}
    </div>
  );
}
