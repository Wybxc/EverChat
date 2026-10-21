# collapsible

2026-10-21, golden pair via CLI / merge, migrated with project customizations preserved.

## Changed

- `src/components/ui/collapsible.tsx`: Root/Trigger/Panel.
- `src/components/ui/trace.tsx`: render types and panel-height transition hooks.
- `src/features/chat/ReasoningContent.tsx`: preserve mounted reasoning with keepMounted.
- Radix import/asChild sweep on this component is clean.

## Left alone

Unrelated controls, cmdk, Recharts, Markdown and Message Scroller are unchanged.

## Behavior changes

Panel keepMounted replaces forceMount; thought content stays mounted for search and selection. Height transitions use Base UI panel measurements.

## Verify by hand

Use Tab, arrows, Space and Enter as applicable; verify disabled controls, both themes, touch hit areas and current settings values. Check streaming thought folding without changing the main reading position.
