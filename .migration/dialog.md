# dialog

2026-10-21 · golden pair via CLI + customized wrapper merge · migrated.

## Changed

- `src/components/ui/dialog.tsx`: Base Backdrop/Popup and render Close; original dimensions and theme retained, native transition state attributes.
- `src/components/Modal.tsx`: native initialFocus/finalFocus and cancelable Root change details; busy dismissal protection and focus handoffs retained.
- `src/app/commands.ts`: native data-open selector.
- `src/app/SettingsDialog.tsx`, `src/features/backup/BackupProgressDialog.tsx`, `src/features/chat/MessageDeleteDialog.tsx`, `useConversationActions.tsx`, `SummaryDialog.tsx`, `src/features/library/GlobalSearch.tsx`: native focus targets and IME escape cancellation.
- Leftover scan: no radix-ui / @radix-ui imports in these component files.

## Left alone

cmdk stays responsible for search keyboard navigation. AlertDialog wrapper is migrated in its own component commit.

## Behavior changes

Base touch opening normally focuses the popup to avoid an unsolicited keyboard. Explicit initialFocus refs in rename/search/confirmation keep their existing behavior. Business confirmation dialogs temporarily use Dialog with alertdialog role and pointer dismissal disabled until the AlertDialog commit.

## Verify by hand

Settings/search/rename open, trap focus, Escape/close return to the intended control. Confirmations focus Cancel. Busy dialogs refuse dismissal. Closing a dialog must not steal focus from the composer or a newly opened dialog. IME Escape must not dismiss search.
