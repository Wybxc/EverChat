# attachment

2026-10-21, golden pair via CLI / merge, migrated; existing semantic classes and variants preserved.

## Changed

- `src/components/ui/attachment.tsx`: AttachmentTrigger uses Base UI useRender/mergeProps with render composition and the existing data-slot.
- Radix import/asChild sweep on this component is clean.

## Left alone

Other presentation parts remain native elements; Message Scroller and third-party libraries are unchanged.

## Behavior changes

Polymorphic composition now uses render; no current consumers use this component's former asChild prop.

## Verify by hand

Check both themes, text wrapping, nested action hit targets and keyboard focus; for attachments also check open/remove and upload states.
