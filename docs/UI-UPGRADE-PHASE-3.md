# Phase 3 — Full-Screen Photo and Video Viewer

Audited before writing code. The viewer already handles navigation, download and
video source switching, so this phase adds only what is measurably missing.

## Already working (verified in code — do not rebuild)

| Requirement | Evidence |
|---|---|
| Full-screen overlay | `.viewer-backdrop` + `role="dialog" aria-modal` |
| Previous / next | `hasPrevious` / `hasNext`, chevrons, wrap-free |
| Escape closes | keydown handler |
| Arrow-key navigation | ArrowLeft / ArrowRight |
| Download | `downloadUrl` anchor |
| Video playback controls | native `controls` |
| Video proxy vs original | "Playing preview" / "Playing original" toggle |
| Error state + retry | `viewer-error`, `retry()` |

## Genuinely missing (the Phase 3 work)

1. **Zoom** — no zoom, pan or fit-to-screen. Zero occurrences of `zoom`/`scale`.
   Needs: wheel zoom, +/− buttons, double-click toggle, drag-to-pan, and reset
   on item change.
2. **Fullscreen** — no Fullscreen API usage. Needs a real browser fullscreen
   request, not just a bigger overlay.
3. **Metadata sidebar** — `metadata` appears once (as a word), no panel. Needs
   date, dimensions, size, camera, location, tags, and the Telegram message id.
4. **Favourite control** — absent from the viewer entirely.
5. **Keyboard expansion** — needs `f` (fullscreen), `+`/`-` (zoom), `0` (fit),
   and `i` (info). Currently only arrows and Escape.

## Plan

1. `useZoomPan` hook — scale, offset, wheel/pinch, clamped so the image cannot
   be dragged out of view.
2. Fullscreen via `requestFullscreen` on the stage element, with state synced to
   the `fullscreenchange` event (the browser can exit without us asking).
3. Metadata panel toggled by a button and `i`.
4. Favourite button calling the existing `toggleFavorite` handler through a new
   `onFavorite` prop.
5. Extend the keydown map, and skip zoom keys when the event target is an input.

## Constraints

- Zoom must not apply to `<video>`; it uses native controls.
- Reset zoom and pan whenever the item changes, or the next photo opens
  magnified.
- Honour `prefers-reduced-motion` for the zoom transition.
- Tokens only, single 767px breakpoint for the metadata panel becoming a sheet.

## Verification

- Wheel zooms in/out, clamped between 1× and 8×.
- Double-click toggles fit ↔ 2×.
- Drag pans only while zoomed; snaps back at 1×.
- `f` enters and exits real fullscreen; state stays correct if the user presses
  the browser's own Escape.
- `i` toggles metadata; panel lists real fields, not placeholders.
- Favourite toggles and persists.
- Zoom resets when moving to the next photo.
- Grid remains pixel-identical; tsc and build clean.
