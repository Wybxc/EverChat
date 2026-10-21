# alert-dialog

2026-10-21 · golden pair via CLI + customized wrapper merge · migrated.

## Changed

- Native Base AlertDialog Root/Backdrop/Popup/Title.
- Modal selects the native confirmation primitive; no outside dismissal; cancel-button initial focus retained.

Leftover scan: no radix-ui / @radix-ui imports in these files.

## Left alone

Business content, compact dimensions and theme tokens retained.

## Behavior changes

Base focuses the first tabbable element by default rather than a special Cancel primitive. Existing business dialogs explicitly provide their cancel refs, preserving their focus policy.

## Verify by hand

Delete message/chat confirmation focuses Cancel, ignores outside press, closes on Escape when not busy, restores surviving trigger or composer.
