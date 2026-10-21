# tooltip

2026-10-21 · golden pair via CLI + customized wrapper merge · migrated.

## Changed

- `src/components/ui/tooltip.tsx`: Base Provider, Trigger, Positioner, Popup and Arrow; position props forwarded to Positioner. Original spacing/colors and zero offset retained.
- `src/components/IconButton.tsx`, `src/features/chat/ConversationNavigation.tsx`: render composition and Provider delay.

Leftover scan: no radix-ui / @radix-ui imports in these component files.

## Left alone

Navigation behavior and Button variants.

## Behavior changes

Base groups consecutive tooltips within a 400 ms timeout (Radix default 300 ms). Explicit 400 ms opening delays retained.

## Verify by hand

Hover icon and navigation controls; keyboard focus tooltip; Escape dismisses; confirm arrow orientation.
