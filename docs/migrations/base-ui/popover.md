# popover

2026-10-21 · golden pair via CLI + customized wrapper merge · migrated.

## Changed

- `src/components/ui/popover.tsx`: native Base Portal → Positioner → Popup, preserving panel styles.
- `src/features/providers/ModelPicker.tsx`, `src/features/chat/ComposerParameters.tsx`, `src/features/chat/ContextEstimate.tsx`: render triggers, native finalFocus and available-height variable.

Leftover scan: no radix-ui / @radix-ui imports in these component files.

## Left alone

At this component migration step, cmdk search/model grouping was retained. The later [Command replacement](command.md) moves model selection from Popover + Command to native Combobox.

## Behavior changes

Base touch opening focuses the popup rather than opening the virtual keyboard automatically; keyboard/mouse still focus the first input. Selecting a model still returns focus to the composer.

## Verify by hand

Open model picker and search/select; Escape returns to trigger; selecting returns to composer; narrow layout parameters remain visible and scrollable.
