import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as v from 'valibot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { ChatModel } from '../../../shared/models/types';
import {
  selectedModelServerTools,
  serverToolCatalog,
  serverToolSelectionSchema,
  type ModelServerTools,
  type ServerToolSelection,
} from '../../../shared/tools/server-tools';
import './locales';

export function ProviderTools({
  model,
  settings = [],
  onChange,
}: {
  model?: ChatModel;
  settings?: ModelServerTools[];
  onChange: (value: ModelServerTools[]) => void;
}) {
  const { t } = useTranslation('chat', { useSuspense: false });
  const catalog = model ? serverToolCatalog(model) : [];
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
                  disabled={!enabled && !valid}
                  onCheckedChange={(checked) =>
                    update(
                      tool,
                      checked && storeSelection.success ? storeSelection.output : undefined,
                    )
                  }
                />
              </label>
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
              onCheckedChange={(checked) => update(tool, checked ? { tool } : undefined)}
            />
          </label>
        );
      })}
    </section>
  );
}
