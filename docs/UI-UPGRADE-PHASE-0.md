# Phase 0 — Repository Analysis and Implementation Plan

Written before any UI change, per the phased strategy. Every claim below was
measured against the code, not recalled.

## 1. Existing architecture

**Stack.** React 18.3 + Vite 6 + TypeScript 5.7. No router, no state library, no
component library, no CSS framework. Four runtime dependencies total
(`react`, `react-dom`, `lucide-react`, `exifr`). This is deliberately minimal and
should stay that way — rule 6 forbids new dependencies where the platform
already suffices.

**Navigation** is a `libraryView` string in `App.tsx` state, not URL routes. That
means no deep links and no browser back-button support. Worth fixing, but it is
a Phase 2+ concern, not Phase 1 — changing it now would destabilise every screen
at once.

**State** is per-screen `useState` in `App.tsx` (892 lines) plus three hooks:
`useLibraryFilters`, `useInfiniteScroll`, `useTheme`, and `usePolling` for
background refresh.

**Styling** is one hand-written `index.css` (2,768 lines) over a 274-line token
layer. Tokens-only, three breakpoints (1279 / 1023 / 767), reduced-motion
respected in three places.

## 2. Design system as it stands

### What is genuinely reusable

| Token group | Count | Verdict |
|---|---|---|
| Typography (`--font-*`, `--text-*`, `--weight-*`) | 11 | Complete |
| Radii, spacing, timing (`--radius-*`, `--gap-*`, `--dur-*`) | 12 | Complete |
| Colour (`--surface-*`, `--on-surface-*`, `--primary-*`, semantic) | 22 | Complete |
| Elevation (`--shadow-1..3`) | 3 | Complete |
| Layers (`--z-*`) | 4 | Complete |

The palette already has light/dark parity and semantic naming
(`--danger-container`, `--success-container`), so Phase 1's "colour system" and
"light and dark themes" requirements are **already met** — they need verifying,
not rebuilding.

### What is missing

Measured by CSS rule count, these Phase 1 requirements have **zero** implementation:

| Requirement | Rules today | Status |
|---|---|---|
| Toast notification system | 0 (inline `.notice` div in App.tsx) | Missing |
| Tooltip | 0 | Missing |
| Dropdown / menu primitive | 0 (each screen rebuilds its own) | Missing |
| Dialog primitive | 0 (two bespoke modals) | Missing |
| Spinner / progress | 0 | Missing |
| Skeleton loader | 0 | Missing |
| Button primitive (`.btn`) | 0 (ad-hoc `ghost-button` / `primary-button`) | Missing |

Also: `focus-visible` appears only **3 times** across 2,768 lines. Keyboard
accessibility is not systematic and Phase 9 requires it to be.

## 3. Backend surface available to the UI

57 routes. All but two (`thumbnails/backfill`, `thumbnails/status`, both redundant
with automatic regeneration) have a UI entry point. No backend work is needed for
Phase 1.

## 4. Visual direction

Match Immich's information density and restraint without copying its source
(AGPL-3.0 — behaviour and layout conventions only):

- Neutral surfaces, one accent, colour reserved for state and danger.
- Compact 8px spacing rhythm; 185px media tiles already established.
- Elevation used sparingly — borders do the separation work, not shadows.
- Motion only where it communicates (drawer, viewer, theme), always cancellable.

## 5. Phase 1 scope — decided

In scope, because each is a real gap:

1. **Toast system** — replace the single inline `notice` string with a queue
   that supports success / error / info, auto-dismiss, and stacking.
2. **Primitive components** — `Button`, `IconButton`, `Tooltip`, `Modal`,
   `Spinner`, `Skeleton`, `Dropdown`.
3. **Tooltip** — needed by topbar icon buttons that currently have no labels.
4. **Focus-visible system** — a single rule set applied consistently.
5. **Shell polish** — sidebar, topbar, spacing audit at all three breakpoints.

Explicitly **out of scope** for Phase 1, to be done in later phases:

- URL routing / deep links (touches every screen — Phase 2+).
- Any change to the media grid or viewer (Phase 2 and 3).
- Splitting `App.tsx`'s 600-line JSX block (Phase 7/9; risky to do mid-shell).

## 6. Risks

1. **Undeclared Noto: `--primary-container` is the only chip background token;
   `--surface-container` does not exist.** A previous fix already hit this.
2. **`itemFromApi` requires a URL-builder argument** — bare `.map(itemFromApi)`
   passes the array index as the builder. Any primitive that renders media must
   go through `format.ts`.
3. **Two bespoke modals exist** (Telegram, media details). Extracting a `Modal`
   primitive must not change their appearance, or Phase 1 "regresses" Phase 4/7
   screens.

## 7. Verification plan

Each Phase 1 item is proven by measurement, not assertion:

- Toast: trigger success and error, assert element count, roles, and dismissal.
- Modal: assert focus trap, Escape close, and restore-focus.
- Tooltip: assert `aria-describedby` wiring and hover/focus parity.
- Focus ring: tab through the shell and count elements with a visible ring.
- Themes: screenshot both, diff background tokens.
- Responsive: measure at 1440 / 1100 / 900 / 390 for overflow.
- Regression: pixel-compare the media grid before and after.

## 8. Definition of done for Phase 1

Sidebar and topbar polished; spacing and typography consistent; navigation works;
both themes correct; responsive verified at three breakpoints; primitives exist
and are used by at least one real screen each; no console errors; `tsc` clean;
pixel-identical media grid.
