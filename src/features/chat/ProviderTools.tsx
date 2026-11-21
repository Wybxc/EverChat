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
  serverToolProbeCandidates,
  serverToolSelectionSchema,
  type ModelServerTools,
  type ServerToolSelection,
  type ServerToolProbeKind,
  type TestedServerTools,
} from '../../../shared/tools/server-tools';
import './locales';
import { api } from '../../platform/api';

export function ProviderTools({
  model,
  open,
  hostedMcp,
  settings = [],
  onChange,
}: {
  model?: ChatModel;
  open: boolean;
  hostedMcp: boolean;
  settings?: ModelServerTools[];
  onChange: (value: ModelServerTools[]) => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const [tested, setTested] = useState<TestedServerTools>({});
  const [testing, setTesting] = useState<ServerToolProbeKind>();
  const [notice, setNotice] = useState<'confirmed' | 'unconfirmed'>();
  const catalog = model
    ? serverToolCatalog({
        ...model,
        testedServerTools: { ...model.testedServerTools, ...tested },
      })
    : [];
  const probes = model
    ? serverToolProbeCandidates(model).filter(
        ({ tool }) => !catalog.some((entry) => entry.tool === tool),
      )
    : [];
  const probe = async (tool: ServerToolProbeKind) => {
    if (!model || testing) return;
    setTesting(tool);
    try {
      const result = await api<{ confirmed: boolean; testedAt?: number }>(
        `/settings/providers/${model.providerId}/server-tools/test`,
        'POST',
        { model: model.model, tool },
      );
      if (result.confirmed && result.testedAt)
        setTested((before) => ({ ...before, [tool]: result.testedAt }));
      setNotice(result.confirmed ? 'confirmed' : 'unconfirmed');
    } catch {
      setNotice('unconfirmed');
    } finally {
      setTesting(undefined);
    }
  };
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
        const prerequisite = tool === 'tool-search' && !hostedMcp;
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
            <span>
              {t(($) => $.providerToolNames[tool])}
              {prerequisite && (
                <span className="block text-xs text-muted-foreground">
                  {t(($) => $.providerToolSearchNeedsMcp)}
                </span>
              )}
            </span>
            <Switch
              checked={enabled}
              disabled={!enabled && (incompatible || prerequisite)}
              onCheckedChange={(checked) => update(tool, checked ? { tool } : undefined)}
            />
          </label>
        );
      })}
      {!!probes.length && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t(($) => $.providerToolProbeHint)}</p>
          <div className="flex flex-wrap gap-2">
            {probes.map(({ tool }) => (
              <Button
                key={tool}
                type="button"
                size="sm"
                variant="secondary"
                disabled={Boolean(testing)}
                onClick={() => void probe(tool as ServerToolProbeKind)}
              >
                {t(($) => $.providerToolProbe, { tool: t(($) => $.providerToolNames[tool]) })}
              </Button>
            ))}
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice === 'confirmed'
            ? t(($) => $.providerToolConfirmed)
            : t(($) => $.providerToolUnconfirmed)}
        </p>
      )}
    </section>
  );
}
