# button

2026-10-21, golden pair via CLI, migrated with existing variants and semantic colors preserved.

## Changed

- `src/components/ui/button.tsx`: real Base UI Button primitive; `render` replaces Slot/asChild; existing variants, disabled opacity and data-ui-button remain.
- `src/features/attachments/DocumentPreviews.tsx`: download remains an anchor using render and nativeButton=false.
- `package.json`, `pnpm-lock.yaml`: add Base UI 1.9 alongside Radix during migration.
- Radix import/asChild sweep on this component is clean.

## Left alone

Other primitives and Message Scroller remain unchanged in this step.

## Behavior changes

Base UI now owns native/non-native button keyboard semantics. Download remains a link.

## Verify by hand

Tab to regular, disabled and download controls; activate download with Enter; verify compact sizing and both themes.
