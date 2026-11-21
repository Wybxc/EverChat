import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as v from 'valibot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { NativeSelect } from '@/components/ui/native-select';
import type { ChatModel } from '../../../shared/models/types';
import {
  selectedModelServerTools,
  serverToolCatalog,
  serverToolSelectionSchema,
  type ModelServerTools,
  type ServerToolSelection,
} from '../../../shared/tools/server-tools';
import './locales';
import { api } from '../../platform/api';

export function ProviderTools({
  model,
  open,
  settings = [],
  onChange,
}: {
  model?: ChatModel;
  open: boolean;
  settings?: ModelServerTools[];
  onChange: (value: ModelServerTools[]) => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const catalog = model ? serverToolCatalog(model) : [];
  const stores = useInfiniteQuery({
    enabled: open && catalog.some(({ tool }) => tool === 'file-search'),
    queryKey: ['provider-tool-stores', model?.providerId, model?.model],
    initialPageParam: '' as string,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({
        model: model!.model,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      return api<{ stores: { id: string; name: string }[]; cursor?: string }>(
        `/settings/providers/${model!.providerId}/server-tool-stores?${query}`,
        'GET',
        undefined,
        signal,
      );
    },
    getNextPageParam: (page) => page.cursor,
    retry: false,
  });
  const selected = model ? selectedModelServerTools(model, settings) : [];
  const fileSearch = selected.find(({ tool }) => tool === 'file-search');
  const [storeInput, setStoreInput] = useState(
    fileSearch?.tool === 'file-search' ? fileSearch.resources.join(', ') : '',
  );
  const storeSelection = v.safeParse(serverToolSelectionSchema, {
    tool: 'file-search',
    resources: storeInput.split(/[,，\s]+/).filter(Boolean),
  });
  function update(tool: ServerToolSelection['tool'], selection?: ServerToolSelection) {
    if (!model) return;
    const others = settings.filter(
      (item) => item.providerId !== model.providerId || item.model !== model.model,
    );
    const tools = [
      ...selected.filter((item) => item.tool !== tool),
      ...(selection ? [selection] : []),
    ];
    onChange([
      ...others,
      ...(tools.length ? [{ providerId: model.providerId, model: model.model, tools }] : []),
    ]);
  }
  return (
    <section className="space-y-2 border-t pt-3" aria-label={t(($) => $.providerTools)}>
      <h3 className="text-sm font-medium">{t(($) => $.providerTools)}</h3>
      <p className="text-xs text-muted-foreground">
        {catalog.length ? t(($) => $.providerToolHint) : t(($) => $.providerToolsUnavailable)}
      </p>
      {catalog.map(({ tool, resources }) => {
        const enabled = selected.some((selection) => selection.tool === tool);
        const incompatible =
          model?.provider === 'gemini' &&
          selected.some(
            (item) => item.tool !== tool && (item.tool === 'file-search' || tool === 'file-search'),
          );
        if (tool === 'file-search') {
          const prefix = resources === 'vector-stores' ? 'vs_' : 'fileSearchStores/';
          const valid =
            storeSelection.success &&
            storeSelection.output.tool === 'file-search' &&
            storeSelection.output.resources.every((id) => id.startsWith(prefix));
          return (
            <div key={tool} className="space-y-2">
              <label className="flex min-h-9 items-center justify-between gap-3 text-sm">
                {t(($) => $.providerToolNames[tool])}
                <Switch
                  checked={enabled}
                  disabled={!enabled && (!valid || incompatible)}
                  onCheckedChange={(checked) =>
                    update(
                      tool,
                      checked && storeSelection.success ? storeSelection.output : undefined,
                    )
                  }
                />
              </label>
              {incompatible && !enabled && (
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.providerToolFileConflict)}
                </p>
              )}
              {stores.data?.pages.some((page) => page.stores.length) && (
                <label className="block space-y-1 text-xs">
                  <span>{t(($) => $.providerToolStorePicker)}</span>
                  <NativeSelect
                    className="w-full"
                    value=""
                    onChange={(event) => {
                      const id = event.currentTarget.value;
                      if (!id) return;
                      setStoreInput((before) =>
                        [...new Set([...before.split(/[,，\s]+/).filter(Boolean), id])]
                          .slice(-2)
                          .join(', '),
                      );
                    }}
                  >
                    <option value="">{t(($) => $.providerToolSelectStore)}</option>
                    {[
                      ...new Map(
                        stores.data.pages.flatMap((page) =>
                          page.stores.map(({ id, name }) => [id, name] as const),
                        ),
                      ).entries(),
                    ].map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              )}
              {stores.hasNextPage && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={stores.isFetchingNextPage}
                  onClick={() => void stores.fetchNextPage()}
                >
                  {t(($) => $.providerToolMoreStores)}
                </Button>
              )}
              {stores.isError && (
                <p className="text-xs text-muted-foreground">
                  {t(($) => $.providerToolStoreListFailed)}
                </p>
              )}
              <label className="block space-y-1 text-xs">
                <span>{t(($) => $.providerToolResources)}</span>
                <Input
                  value={storeInput}
                  placeholder={prefix}
                  maxLength={450}
                  onChange={(event) => setStoreInput(event.currentTarget.value)}
                />
                <span className="block text-muted-foreground">
                  {t(($) => $.providerToolResourceHint)}
                </span>
              </label>
              {enabled &&
                valid &&
                storeInput !==
                  (fileSearch?.tool === 'file-search' ? fileSearch.resources.join(', ') : '') && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => storeSelection.success && update(tool, storeSelection.output)}
                  >
                    {t(($) => $.providerToolSaveStores)}
                  </Button>
                )}
            </div>
          );
        }
        return (
          <label className="flex min-h-9 items-center justify-between gap-3 text-sm" key={tool}>
            {t(($) => $.providerToolNames[tool])}
            <Switch
              checked={enabled}
              disabled={!enabled && incompatible}
              onCheckedChange={(checked) => update(tool, checked ? { tool } : undefined)}
            />
          </label>
        );
      })}
    </section>
  );
}
