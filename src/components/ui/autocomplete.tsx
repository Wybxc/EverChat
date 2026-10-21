import { Autocomplete as AutocompletePrimitive } from '@base-ui/react/autocomplete';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { InputGroup, InputGroupAddon, InputGroupInput } from './input-group';

const Autocomplete = AutocompletePrimitive.Root;
const AutocompleteCollection = AutocompletePrimitive.Collection;
const AutocompleteGroup = AutocompletePrimitive.Group;

function AutocompleteInput(props: AutocompletePrimitive.Input.Props) {
  return (
    <div data-slot="search-input-wrapper" className="p-1 pb-0">
      <InputGroup>
        <AutocompletePrimitive.Input
          render={<InputGroupInput />}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229)
              event.preventBaseUIHandler();
          }}
          {...props}
        />
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <AutocompletePrimitive.List
      data-slot="autocomplete-list"
      className={cn('outline-none', className)}
      {...props}
    />
  );
}

function AutocompleteItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        'rounded-lg outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground',
        className,
      )}
      {...props}
    />
  );
}

function AutocompleteLabel({ className, ...props }: AutocompletePrimitive.GroupLabel.Props) {
  return (
    <AutocompletePrimitive.GroupLabel
      className={cn('px-3 py-1.5 text-xs font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Autocomplete,
  AutocompleteInput,
  AutocompleteList,
  AutocompleteItem,
  AutocompleteGroup,
  AutocompleteLabel,
  AutocompleteCollection,
};
