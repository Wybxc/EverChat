import { useTranslation } from 'react-i18next';
import './locales';
import { useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ChatModel } from '../../../shared/models/types';
import { modelSelectionKey } from '../../../shared/models/selection';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

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
  const selectedInMenu = useRef(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          role="combobox"
          data-model-key={modelSelectionKey(selected)}
          aria-label={t(($) => $.chatModel)}
          aria-expanded={open}
          className="min-w-11 flex-1 justify-between gap-1 px-2 sm:max-w-80"
          title={`${selected.providerName} · ${selected.name}`}
        >
          <span className="truncate">
            {selected.providerName} · {selected.name}
          </span>
          <ChevronDown className="size-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        onCloseAutoFocus={(event) => {
          if (selectedInMenu.current) {
            event.preventDefault();
            selectedInMenu.current = false;
            focusComposer();
          }
        }}
      >
        <Command>
          <CommandInput
            placeholder={t(($) => $.searchModels)}
            aria-label={t(($) => $.searchModels)}
          />
          <CommandList>
            <CommandEmpty>{t(($) => $.noModelMatches)}</CommandEmpty>
            {[...new Set(models.map((model) => model.providerId))].map((providerId) => (
              <CommandGroup
                key={providerId}
                heading={models.find((model) => model.providerId === providerId)!.providerName}
              >
                {models
                  .filter((model) => model.providerId === providerId)
                  .map((model) => (
                    <CommandItem
                      data-model-key={modelSelectionKey(model)}
                      key={modelSelectionKey(model)}
                      value={modelSelectionKey(model)}
                      keywords={[model.name, model.model, model.providerName]}
                      onSelect={() => {
                        selectedInMenu.current = true;
                        choose(modelSelectionKey(model));
                        setOpen(false);
                      }}
                      className="gap-2"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {model.name}
                        {models.some(
                          (other) =>
                            other !== model &&
                            other.providerId === providerId &&
                            other.name === model.name,
                        ) && (
                          <span className="ml-2 text-xs text-muted-foreground">{model.model}</span>
                        )}
                      </span>
                      {modelSelectionKey(model) === modelSelectionKey(selected) && (
                        <Check className="size-4 shrink-0" />
                      )}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
