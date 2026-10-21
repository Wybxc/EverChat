# switch

2026-10-21, golden pair via CLI / merge, migrated with project customizations preserved.

## Changed

- `src/components/ui/switch.tsx`: Base UI Root and indicator/thumb; existing compact dimensions and semantic checked colors retained.
- Radix import/asChild sweep on this component is clean.

## Left alone

Unrelated controls, cmdk, Recharts, Markdown and Message Scroller are unchanged.

## Behavior changes

Base UI renders a span with an associated hidden input; disabled styles use data-disabled. Controlled checked values are preserved.

## Verify by hand

Use Tab, arrows, Space and Enter as applicable; verify disabled controls, both themes, touch hit areas and current settings values. Check streaming thought folding without changing the main reading position.
