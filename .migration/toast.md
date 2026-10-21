# toast

2026-10-21 · engine (custom Radix composition) + Base registry reference · migrated.

## Changed

- `src/components/ui/toast.tsx`: Base manager, viewport, toast content/description/close; notifications remain inside the active dialog for accessibility and keyboard retry.
- `src/components/AutosaveToast.tsx`: one stable per-store manager ID; upsert transitions; saved timeout 2500 ms; saving/error persist; close on unmount; no initial saved announcement.
- `src/platform/i18n/locales/en/common.ts`, `zh-CN/common.ts`: remove obsolete Radix hotkey template.
- Leftover scan: no radix-ui / @radix-ui imports in these files.

## Left alone

Autosave persistence/retry logic and all business settings fields remain unchanged.

## Behavior changes

Base Toast uses F6 to focus the notification viewport (Radix F8); manager priority replaces foreground/background announcements. Notifications retain compact layout; Base handles announcements and pause-on-hover/focus/blur.

## Verify by hand

Opening settings emits no toast/save. Edit a field: one saving toast, focus stays in field; success dismisses. Failed save persists across tabs; F6 and keyboard Retry work inside the modal. Closing/reopening settings must not resurrect old notifications.
