# dropdown-menu

2026-10-21 · golden pair via CLI + customized wrapper merge · migrated.

## Changed

- `src/components/ui/dropdown-menu.tsx`: Base Menu with Portal/Positioner/Popup; Group/GroupLabel; original compact classes and position defaults retained.
- `src/components/ActionMenu.tsx`: render trigger, onClick and closeOnClick; actions run directly, independent of cancelable focus cleanup. Native menu focus return replaces the old deferred action queue.
- `src/app/App.tsx`, `src/features/chat/ConversationActions.tsx`, `MessageActions.tsx`, `SummaryView.tsx`: native click handlers; labeled organize/reuse/export/backup/task groups.
- `src/features/chat/useConversationActions.tsx`: capture a menu-trigger return target and adjacent row before opening a dialog, preserving rename/delete focus return.
- Leftover scan: no radix-ui / @radix-ui imports in these files.

## Left alone

cmdk CommandItem onSelect and its search/selection behavior are unrelated and retained.

## Behavior changes

Base normal items close on click; copy-link explicitly keeps the menu open through closeOnClick=false. No checkbox/radio menu items are used. Base touch menus can leave page scrolling enabled when the menu does not span the viewport.

## Verify by hand

Open sidebar/top/message menus by mouse and keyboard; arrows skip disabled items; Escape restores trigger; rename opens a focused input; copy-link stays open; import invokes chooser.
