# UI source

shadcn/ui Radix primitives and Nova styles, sourced from the official repository at `c2477f311c19982ef6e246085438e6cfec3e35ea` (2026-10-15). CLI: 4.21.5. The registry timed out, so components were installed manually from `apps/v4/registry/bases/radix/ui` and the Nova class map was expanded from `apps/v4/registry/styles/style-nova.css`, equivalent to the registry transform.

Local adaptations: accessible control sizes and opaque focus rings; a stable `data-ui-button` marker when Radix triggers replace `data-slot`; EverChat semantic colors; caller-controlled dialog widths and Chinese close labels; Tabs orientation and Progress value forwarded to Radix; separate NativeSelect wrapper/select classes; decorative Spinner defaults. Business modal registration and focus policy live in `src/components/Modal.tsx`. Source-owned; no DaisyUI compatibility layer. Upstream: https://github.com/shadcn-ui/ui (MIT).
