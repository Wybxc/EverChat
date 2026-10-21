# tabs

2026-10-21, golden pair via CLI / merge, migrated with project customizations preserved.

## Changed

- `src/components/ui/tabs.tsx`: Root/List/Tab keep compact line/default variants and orientation rules, using native data-orientation for layout because the default horizontal aria-orientation is omitted.
- `src/style.css`: settings active-state selector uses data-active.
- `src/features/chat/ConversationSettings.tsx`: native data-orientation keeps parameter tabs at their original height.
- Radix import/asChild sweep on this component is clean.

## Left alone

Unrelated controls, cmdk, Recharts, Markdown and Message Scroller are unchanged.

## Behavior changes

Keyboard arrows move focus; activation now follows the Base UI manual default (Enter/Space). This is an explicit change from Radix automatic activation. Click activation is unchanged.

## Verify by hand

Use Tab, arrows, Space and Enter as applicable; verify disabled controls, both themes, touch hit areas and current settings values. Check streaming thought folding without changing the main reading position.
