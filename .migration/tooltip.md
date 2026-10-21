# tooltip

2026-10-21 · golden pair via CLI + customized wrapper merge · migrated.

## Changed

- `src/components/ui/tooltip.tsx`: Base Provider, Trigger, Positioner, Popup and Arrow; position props forwarded to Positioner. Original spacing/colors and zero offset retained.
- `src/components/IconButton.tsx`, `src/features/chat/ConversationNavigation.tsx`: render composition and Provider delay.

Leftover scan: no radix-ui / @radix-ui imports in these component files.

## Left alone

Navigation behavior and Button variants.

## Behavior changes

Base groups consecutive tooltips within a 400 ms timeout (Radix default 300 ms). Explicit 400 ms opening delays retained. Focus opening follows focus-visible keyboard modality. Base UI 1.9 tooltips are visual-only and omit the old tooltip role/description relationship; triggers retain matching aria-labels. Tests inspect the visual popup and the trigger name separately, following the [official usage guidance](https://base-ui.com/react/components/tooltip#usage-guidelines).

## Verify by hand

Hover icon and navigation controls; keyboard focus tooltip; Escape dismisses; confirm arrow orientation.
