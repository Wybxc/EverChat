# sheet

2026-10-21 · golden pair via CLI + customized wrapper merge · migrated.

## Changed

- Base Dialog Root/Backdrop/Popup and render Close.
- Native transition attributes for each slide direction; mobile sidebar uses finalFocus targets.

Leftover scan: no radix-ui / @radix-ui imports in these files.

## Left alone

Business content, compact dimensions and theme tokens retained.

## Behavior changes

Base touch opening focuses the popup by default, avoiding a keyboard. Intentional navigation/dialog focus is not overwritten when the sidebar closes.

## Verify by hand

Mobile: open sidebar, close by button/outside/Escape, navigate conversation/new-chat, open settings/search; focus and scrolling must remain usable.
