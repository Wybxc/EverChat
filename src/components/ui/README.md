# UI source

shadcn/ui Base UI primitives and Nova styles. `components.json` uses `base-nova`; interactive primitives use `@base-ui/react` 1.9.0. The 2026-10-21 migration fetched official Radix Nova / Base Nova golden pairs through the shadcn CLI and replayed local customizations rather than overwriting the wrappers. Per-component notes and verification live in [the migration report](../../../docs/migrations/base-ui/project.md).

The original Radix wrappers came from official shadcn/ui revision `c2477f311c19982ef6e246085438e6cfec3e35ea` (2026-10-15); later AI Elements additions came through the registry. Source-owned; upstream shadcn/ui is MIT: https://github.com/shadcn-ui/ui.

Local adaptations: accessible control sizes and opaque focus rings; stable `data-ui-button` markers across render composition; EverChat semantic colors; caller-controlled dialog widths and translated close labels; native orientation/state attributes; real Progress values; separate NativeSelect wrapper/select classes; decorative Spinner defaults. Business modal registration and focus policy live in `src/components/Modal.tsx`.

Control density: secondary buttons, Tabs and menu items have a 32 CSS px minimum for mouse input; touch-capable or narrow screens keep 44 CSS px. Explicit larger controls retain their own sizes. See [message editing and density](../../../docs/plans/message-editing-density-plan.md).

Toast uses the Base UI manager and keeps its viewport and announcements inside the active dialog. Autosave lifecycle and retry behavior live in `src/components/AutosaveToast.tsx`. F6 focuses notifications. Tabs use manual keyboard activation: arrows move focus; Enter/Space activates. Tooltips are supplementary visual labels; matching accessible names remain on their triggers.

cmdk, Recharts, Streamdown and the `@shadcn/react` Message Scroller are intentionally unchanged. cmdk still has indirect Radix dependencies; there are no direct Radix imports in the UI wrappers.
