# progress

2026-10-21, golden pair via CLI / merge, migrated with project customizations preserved.

## Changed

- `src/components/ui/progress.tsx`: Base UI Root/Track/Indicator for bars; remove hand-written translateX fill; retain native circular presentation and semantic colors.
- Radix import/asChild sweep on this component is clean.

## Left alone

Unrelated controls, cmdk, Recharts, Markdown and Message Scroller are unchanged.

## Behavior changes

Base UI manages linear fill and progress semantics. The existing decorative SVG ring stays under Root so short-conversation low usage remains visible.

## Verify by hand

Use Tab, arrows, Space and Enter as applicable; verify disabled controls, both themes, touch hit areas and current settings values. Check streaming thought folding without changing the main reading position.
