# Pearl Glass UI

The panel adapts the Pearl Glass design language from
[scaffold-master](https://github.com/wbr664393425-lgtm/scaffold-master).
See the repository's `THIRD_PARTY_NOTICES.md` for its MIT notice.

## Organization

- `index.css`: Tailwind mappings, existing mobile/native safe-area rules,
  overlays and business-specific layout safeguards.
- `styles/pearl.css`: shared light/dark tokens, materials and shell geometry.
  Loaded after `index.css` in `main.tsx`.
- `components/ui`: existing React/Radix primitives with shared presentation
  classes. Keep their refs, Slot composition and accessibility contracts.
- `PearlSidebarContent`: measures the real active menu item's bounds. Its
  finite slide survives route shell remounts without retaining DOM nodes;
  observers, frames, listeners and animations are cleaned up.
- `MotionPolicy`: system reduced-motion preferences for Motion components;
  visibility-aware animation permission for dashboard charts.

## Extension rules

Use theme tokens rather than hard-coded white surfaces. Shared materials belong
in the component layer so utility classes can still express errors, selection,
sizes and other business states. Only the desktop shell geometry and the
measured navigation marker intentionally override primitive utility geometry.

Use `pearl-page-header` on page header containers; retain responsive action
wrapping and avoid a second framed heading in embedded group editors. Keep
charts tied to real data: decorative instrument ticks are not measurements.

`Card` supports an opt-in `variant="featured"` for primary dashboard readouts
and `interactive` for border/shadow feedback, not a new click target. Do not
translate/scale sortable cards on hover. Use `pearl-readout` for recessed inner
metrics, and keep offline/error/selection utility overrides intact.

`ContentTransition` shares finite exit/reveal timing across rules, tunnels and
groups, does not replay on polling under the same key, and makes exiting panels
inert. `pearl-disclosure-grid` handles existing controlled group expansions;
`pearl-disclosure` progressively animates native details without unmounting form
inputs. Unsupported browsers use normal native disclosure. Sliding tab bars
scroll only their own horizontal viewport, never the surrounding page.

Use short, finite transform/opacity animations, honor reduced motion and hidden
tabs, and clean up listeners/observers/frames on unmount. Avoid a blur layer on
every host/rule card and do not add animation frameworks or remote font assets.

Run `pnpm test:ui`, `pnpm test:i18n`, `pnpm exec tsc --noEmit`, and `pnpm build`.
Also inspect desktop/mobile, light/dark, long English labels, dialogs and menus
in `pnpm dev:panel` before releasing; static tests are not a visual acceptance.
