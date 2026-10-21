# dialog

2026-10-21 · golden pair via CLI + customized wrapper merge · migrated.

## Changed

- `src/components/ui/dialog.tsx`: Base Backdrop/Popup and render Close; original dimensions and theme retained, native transition state attributes.
- `src/components/Modal.tsx`: native initialFocus/finalFocus and cancelable Root change details; busy dismissal protection and focus handoffs retained.
- `src/app/commands.ts`: native data-open selector.
- `src/app/SettingsDialog.tsx`, `src/features/backup/BackupProgressDialog.tsx`, `src/features/chat/MessageDeleteDialog.tsx`, `useConversationActions.tsx`, `SummaryDialog.tsx`, `src/features/library/GlobalSearch.tsx`: native focus targets and IME escape cancellation.
- `src/features/providers/ProviderEditor.tsx`: disclosure resets only replace model details, preserving the focused provider controls and the new-provider name focus.
- `src/features/chat/useConversationActions.tsx`: dialogs capture the menu trigger as their native finalFocus target without moving focus before dispatch.
- `src/features/chat/ConversationSettings.tsx`: reset tab scroll and focus the invalid field together during layout, preventing an asynchronous focus race when the error action disappears.
- Leftover scan: no radix-ui / @radix-ui imports in these component files.

## Left alone

cmdk stays responsible for search keyboard navigation. AlertDialog wrapper is migrated in its own component commit.

## Behavior changes

Base touch opening normally focuses the popup to avoid an unsolicited keyboard. Explicit initialFocus refs in rename/search/confirmation keep their existing behavior. Confirmations use the separately migrated native AlertDialog; no temporary role substitution remains.

## Verify by hand

Settings/search/rename open, trap focus, Escape/close return to the intended control. Confirmations focus Cancel. Busy dialogs refuse dismissal. Closing a dialog must not steal focus from the composer or a newly opened dialog. IME Escape must not dismiss search.
