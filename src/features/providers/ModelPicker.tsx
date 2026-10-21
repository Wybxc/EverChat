import { useTranslation } from 'react-i18next';
import './locales';
import { useMemo, useRef, useState } from 'react';
import type { ChatModel } from '../../../shared/models/types';
import { modelSelectionKey } from '../../../shared/models/selection';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxTrigger,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxCollection,
  ComboboxEmpty,
} from '@/components/ui/combobox';
import { groupModels, searchModels } from './model-search';

export function ModelPicker({
  models,
  selected,
  choose,
  focusComposer,
}: {
  models: ChatModel[];
  selected: ChatModel;
  choose: (value: string) => void;
  focusComposer: () => void;
}) {
  const { t } = useTranslation('providers', { useSuspense: false });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selectedInMenu = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const groups = useMemo(() => groupModels(models), [models]);
  const filteredGroups = useMemo(() => groupModels(searchModels(models, query)), [models, query]);
  return (
    <Combobox<ChatModel>
      items={groups}
      filteredItems={filteredGroups}
      filter={null}
      value={selected}
      isItemEqualToValue={(left, right) => modelSelectionKey(left) === modelSelectionKey(right)}
      itemToStringLabel={(model) => model.name}
      itemToStringValue={modelSelectionKey}
      inputValue={query}
      onInputValueChange={setQuery}
      loopFocus={false}
      open={open}
      onOpenChange={(next, details) => {
        if (
          !next &&
          details.reason === 'escape-key' &&
          details.event instanceof KeyboardEvent &&
          (details.event.isComposing || details.event.keyCode === 229)
        ) {
          details.cancel();
          return;
        }
        selectedInMenu.current = !next && details.reason === 'item-press';
        setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setQuery('');
      }}
      onValueChange={(model) => {
        if (model) choose(modelSelectionKey(model));
      }}
    >
      <ComboboxTrigger
        render={
          <Button
            ref={trigger}
            type="button"
            variant="ghost"
            data-model-key={modelSelectionKey(selected)}
            aria-label={t(($) => $.chatModel)}
            className="min-w-11 flex-1 justify-between gap-1 px-2 sm:max-w-80"
            title={`${selected.providerName} · ${selected.name}`}
          />
        }
      >
        <span className="truncate">
          {selected.providerName} · {selected.name}
        </span>
      </ComboboxTrigger>
      <ComboboxContent
        side="top"
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)]"
        finalFocus={() => {
          if (selectedInMenu.current) {
            selectedInMenu.current = false;
            focusComposer();
            return false;
          }
          return trigger.current;
        }}
      >
        <ComboboxInput
          placeholder={t(($) => $.searchModels)}
          aria-label={t(($) => $.searchModels)}
        />
        <ComboboxEmpty>{t(($) => $.noModelMatches)}</ComboboxEmpty>
        <ComboboxList>
          {(group: (typeof groups)[number]) => (
            <ComboboxGroup key={group.providerId} items={group.items}>
              <ComboboxLabel>{group.items[0].providerName}</ComboboxLabel>
              <ComboboxCollection>
                {(model: ChatModel) => (
                  <ComboboxItem
                    key={modelSelectionKey(model)}
                    value={model}
                    data-model-key={modelSelectionKey(model)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {model.name}
                      {models.some(
                        (other) =>
                          other !== model &&
                          other.providerId === model.providerId &&
                          other.name === model.name,
                      ) && (
                        <span className="ml-2 text-xs text-muted-foreground">{model.model}</span>
                      )}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
