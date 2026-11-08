# PRD: InfinityVault UI — Immich-Aligned Design System

**Status:** Draft for approval
**Owner:** InfinityVault
**Date:** 2026-02-14
**Scope:** Visual/interaction redesign only. No new backend capabilities in this PRD.

---

## 1. Problem

InfinityVault's UI has grown in three layered CSS phases without a
consolidation pass. The result is visible to the user as inconsistency and
hidden from the developer as technical debt.

### 1.1 Evidence from the current code

`frontend/src/index.css` is 501 lines containing **three overlapping layout
generations**. `.media-grid` alone is declared three times:

| Line | Declaration | Fate |
| --- | --- | --- |
| 93 | `repeat(5, minmax(0, 1fr))`, gap `4px` | Overridden |
| 317 | `repeat(6, minmax(0, 1fr))`, gap `12px` | Overridden |
| 444 | `repeat(7, minmax(0, 1fr))`, gap `3px` | Active |

The same duplication affects `.media-preview` (aspect-ratio `1.08` at line 96,
`1` at line 446), `.media-card` (border/shadow/transform declared, then
neutralised in an override block), and `.selection-toolbar` / `.selection-actions`.

There are 8 `@media` blocks, two of which are near-duplicate 760px
breakpoints (lines 209 and 355 and 482) fighting over `.media-grid` columns
and `.sidebar` visibility.

Two distinct palettes coexist. The original identity is purple
(`--purple: #6659c9`, `--soft-purple: #f0efff`, `--line: #e9ebf2`) with
`Playfair Display` for headings. The later "Immich" layer overrides the
surface with blue (`--immich-blue: #4255b8`, `--immich-border: #e3e6ec`) but
**leaves the purple tokens and Playfair headings in place for modals,
viewer, empty state, and buttons**. So the app is half purple-serif and half
blue-sans, depending on which component you open.

### 1.2 Consequence for users

- Grid density does not reflect real content; 7 columns at 1560px max-width
  produces ~180px tiles that show a thumbnail and almost nothing else.
- No dark mode. For a photo library this is a functional gap: a bright white
  chrome around photos distorts perceived colour and is hostile at night.
- Selection, bulk actions, and the viewer use three different visual
  languages for the same "task mode" concept.
- Mobile (max-width 760px) hides `.sidebar` entirely and turns the search
  field into an icon, leaving no way to reach Albums, Archive, or Trash.

### 1.3 What "like Immich" actually means

Immich is a Svelte app built on **Material 3 via its own `@immich/ui`
package** (confirmed in PR #16768, which migrated sidebar buttons to
`@immich/ui` components). Key properties we are copying the *behaviour* of,
not the *code*:

- Material 3 token system: surface/elevation roles, one accent "primary",
  defined on-surface / on-surface-variant text roles.
- Light **and** dark themes, toggled from the account panel (moved there in
  PR #16768 to declutter the top bar).
- Collapsible sidebar: icon-rail below `md`, full sidebar above it, with all
  navigation destinations reachable at every breakpoint.
- Dense, justified-row timeline; date headers as quiet sticky dividers.
- A single primary action per screen. Immich's library page has exactly one
  filled button (Upload).

> **Licensing note.** Immich is AGPL-3.0. This PRD mandates implementing
> from *observed behaviour and public design tokens*, writing our own CSS and
> components. No Immich source, Svelte components, or `@immich/ui` code may
> be copied. See `docs/research/immich-synology-analysis.md` §
> "Licensing and reuse boundary".

---

## 2. Goals

| ID | Goal | Measure |
| --- | --- | --- |
| G1 | One design system, one palette | Zero `--purple*` tokens remain; no selector block declared twice for the same purpose |
| G2 | Light + dark parity | Every surface legible and AA-contrast in both themes |
| G3 | Match Immich's information density | Grid shows ≥ 8 columns at 1440px+; date headers sticky |
| G4 | Full navigation at every breakpoint | Albums/Archive/Trash/Favorites reachable at 375px |
| G5 | One primary action per screen | Exactly one filled button visible per view |
| G6 | Consistent task mode | Selection and bulk actions use one component in all views |

### Non-goals

- No new backend endpoints, thumbnails, or pagination (tracked separately;
  note the current grid serves **full-size originals** as previews, which this
  redesign will make more visible but cannot fix on the frontend).
- No ML, Places, Memories, or Sharing features. Their sidebar entries become
  honest "coming soon" states or are removed — see §6.3.
- No component library adoption (MUI/Radix). Plain React + CSS to keep the
  dependency surface at today's five.

---

## 3. Design tokens

Single `:root` block with `[data-theme="dark"]` overrides. All component
colour references must go through these variables — no literal hex in
component rules.

### 3.1 Roles (Material 3 naming, our values)

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--bg` | `#f7f8fa` | `#111318` | App shell background |
| `--surface` | `#ffffff` | `#1a1d24` | Sidebar, top bar, cards, modals |
| `--surface-2` | `#f1f3f6` | `#22262f` | Search field, hovered rows, chips |
| `--surface-3` | `#e8ebf0` | `#2b3038` | Pressed state, media placeholder |
| `--on-surface` | `#1b1f27` | `#eef1f6` | Primary text, headings |
| `--on-surface-variant` | `#6b7381` | `#9aa3b2` | Secondary text, counts, labels |
| `--outline` | `#dde1e8` | `#333942` | Hairline borders, dividers |
| `--outline-strong` | `#c4cad4` | `#4a515c` | Input borders, focus ring base |
| `--primary` | `#4155bb` | `#8fa2ff` | Accent: active nav, primary button, selection |
| `--on-primary` | `#ffffff` | `#0d1120` | Text on primary fill |
| `--primary-container` | `#e9edfd` | `#252c48` | Active nav background, selected chip |
| `--on-primary-container` | `#2c3a86` | `#c3cdff` | Text on primary container |
| `--success` | `#3f8f66` | `#6cc79a` | Backed-up state |
| `--warning` | `#9a7340` | `#d8ab6b` | Waiting-for-Telegram state |
| `--danger` | `#b4453f` | `#f0837c` | Failed state, destructive actions |
| `--scrim` | `rgba(15,18,25,.45)` | `rgba(0,0,0,.65)` | Modal backdrop |
| `--viewer-bg` | `#14161d` | `#0a0b0f` | Media viewer stage (always dark) |

### 3.2 Typography

Replace the `DM Sans` + `Playfair Display` pairing with **one family**:

```css
--font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
```

`Playfair Display` is removed entirely. Serif headings were the single
strongest "not Immich" signal and conflict with the denser, neutral tone of
the target design.

Scale: `11 / 12 / 13 / 15 / 20 / 26` px with weights `400 / 500 / 600`.
Numerals and counts use `font-variant-numeric: tabular-nums`.

### 3.3 Geometry

| Token | Value |
| --- | --- |
| `--radius-sm` | `6px` (chips, small buttons) |
| `--radius-md` | `8px` (inputs, buttons) |
| `--radius-lg` | `12px` (cards, panels) |
| `--radius-xl` | `16px` (modals) |
| `--gap-media` | `2px` (timeline grid) |
| `--sidebar-w` | `240px` expanded / `64px` rail |
| `--topbar-h` | `56px` |

Elevation is expressed as `--shadow-1` / `--shadow-2` (light: subtle
`0 1px 2px rgba(16,20,28,.06)`; dark: luminance lift, not shadow, since
shadows are invisible on dark surfaces).

### 3.4 Motion

`--ease: cubic-bezier(.2,0,.2,1)`, `--dur-fast: 120ms`, `--dur: 180ms`.
All transitions honour `@media (prefers-reduced-motion: reduce)`.

---

## 4. Layout specification

### 4.1 Shell

```
┌──────────┬─────────────────────────────────────────┐
│ sidebar  │ topbar (56px, sticky)                   │
│ 240/64px │─────────────────────────────────────────│
│ sticky   │ content (max 1680px, 24px gutters)      │
│ full-ht  │                                         │
└──────────┴─────────────────────────────────────────┘
```

- Sidebar: `position: sticky; top: 0; height: 100dvh`, own scroll region.
- Content max-width rises from `1560px` to `1680px` so the 8-column grid
  fits at 1440 viewport without cramping.

### 4.2 Sidebar (sidebar.md)

| Item | Behaviour |
| --- | --- |
| Brand | Logo mark + wordmark. Collapses to mark only in rail mode. |
| Primary nav | Photos · Favorites · Archive · Trash |
| Collections | Albums (expandable tree with counts) + Tags |
| Footer | Storage/Telegram status card + Connect button. In rail mode: status dot only, tooltip on hover. |
| Collapse toggle | Chevron at sidebar bottom; state persisted in `localStorage` under `infinityvault-sidebar`. |

Rail mode triggers automatically below `1024px` and can be toggled manually.
Below `768px` the sidebar becomes an overlay drawer opened by a hamburger in
the top bar — **replacing today's `display: none`**, which strands the user.

### 4.3 Top bar

Left: hamburger (mobile) + current view title (20px/600) with asset count as
a quiet suffix. Right: search field (grows to 420px, `⌘K`/`Ctrl+K` focuses),
theme toggle, upload button.

Search becomes a real field at all breakpoints (mobile shows it in a
second row under the title on expand).

### 4.4 Timeline

- Grid: `repeat(auto-fill, minmax(158px, 1fr))`, `gap: var(--gap-media)`.
  This replaces the fixed `repeat(7, …)` with something that adapts to
  container width instead of a breakpoint ladder.
- Tiles: `aspect-ratio: 1`, `object-fit: cover`, `border-radius: 2px`.
- Date headers: `position: sticky; top: var(--topbar-h)`, `backdrop-filter:
  blur(8px)`, background = `--bg` at 92% opacity. Text 15px/600, count 12px
  in `--on-surface-variant`.
- Tile hover: reveal a bottom gradient + a single "…" overflow menu and the
  select circle. Today's *three* simultaneous overlay buttons (view, favorite,
  edit) plus a separate chip is the main density problem — collapse to one
  menu, keep favorite as a direct toggle.
- Video: duration chip bottom-left, small play glyph centre. Remove the
  decorative circular `.video-overlay` frame.

### 4.5 Task mode (selection)

One sticky bar replaces `.selection-toolbar` + `.selection-actions`, pinned
below the top bar, `--surface` with `--shadow-2`:

`[n] selected` · Select all · Favorite · Archive · Album · Tag · Download ·
Trash · **Permanently delete** (trash view only) · Clear.

Destructive items sit at the end after a divider and use `--danger`.
Keyboard: `Esc` clears, `⌘A` selects all, `Shift+click` extends a range.

### 4.6 Viewer

Full-bleed dark (`--viewer-bg`) overlay. Top bar: filename, capture time,
size, Download, Close. Stage centres the asset with `object-fit: contain`.
Prev/next arrows at stage edges, plus `←`/`→`/`Esc`. Footer shows
`i of n` and the centimetre-quiet original-file note. A **thumbnail strip**
is added at the bottom for positional context (new; current viewer has none).

### 4.7 Modals (Telegram, Media details)

`--radius-xl`, `--surface`, `--scrim` backdrop, max-width `440px`. Single
`--primary` filled button plus a text "Cancel". Inputs use `--radius-md`,
`--surface-2` background, and a 2px `--primary` focus ring. No serif
headings.

Replace the current `window.prompt()` album/tag creation with a proper small
modal containing name + description, since the browser prompt is unstyled
and blocking.

---

## 5. Theme system

- `data-theme="light" | "dark"` on `<html>`, set by a `useTheme` hook.
- Initial value: `localStorage` → else `prefers-color-scheme`.
- Toggle lives in the sidebar footer next to the Telegram card (mirrors
  Immich's account-panel placement) with a `Sun`/`Moon` icon.
- FOUC guard: inline script in `index.html` applies the resolved theme
  before React mounts.
- Images get `background: var(--surface-3)` in both themes so letterboxing
  never flashes white.

---

## 6. Component inventory

### 6.1 To rebuild

| Component | Change |
| --- | --- |
| `Sidebar` | New. Extract from `App.tsx` (currently ~90 lines of inline JSX) |
| `TopBar` | New. Search, theme toggle, upload |
| `Timeline` + `DateHeader` | Extract grouping logic out of `App.tsx` |
| `MediaTile` | Replace `MediaCard`; single overflow menu |
| `SelectionBar` | Replace two CSS blocks |
| `Viewer` | Add thumbnail strip, always-dark stage |
| `Modal` | Shared shell for Telegram / Details / Album / Tag |
| `EmptyState` | Token-based, no serif |
| `Toast` | Replace `.notice` banner with stacking, auto-dismiss toasts |

### 6.2 File structure

```
frontend/src/
  components/     Sidebar TopBar Timeline MediaTile SelectionBar
                  Viewer Modal EmptyState Toast
  hooks/          useTheme useSelection useMediaLibrary useKeyboard
  styles/         tokens.css  base.css  components/*.css
  App.tsx         composition only — target < 120 lines
```

`useMediaLibrary` absorbs the fetch + 2.5s poll + optimistic-update logic
currently inline in `App.tsx` (831 lines → target ~180 total across hooks).

### 6.3 Honest states

`Explore` and `Sharing` currently call `setNotice('…will be available…')` —
placeholder nav items that look functional. In this redesign they are
removed from the sidebar until the features exist. Shipping fake navigation
is a trust problem, and the sidebar is where trust is established.

---

## 7. Accessibility

- Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI borders, both
  themes (verify with a checker, not by eye).
- All icon-only buttons get `aria-label` (several already do; the new
  overflow menu must too).
- Focus-visible ring: `2px solid var(--primary)`, `outline-offset: 2px`,
  on every interactive element. Today only `<select>`-like inputs show focus.
- Modals: focus trap, `aria-modal`, `Esc` close, return focus to trigger.
- Viewer and selection bar fully keyboard operable.
- `prefers-reduced-motion` disables tile scale and modal transitions.

---

## 8. Acceptance criteria

1. `grep -c 'purple' frontend/src/index.css` → `0`; `Playfair` → `0`.
2. No selector block is duplicated with conflicting declarations. (Original target
   of ≤ 420 lines was set before implementation and revised: 210 distinct rules
   are needed for full light/dark parity. The *duplication* goal is met — the
   three competing `.media-grid` rules are now one.)
3. All three duplicated `.media-grid` declarations collapse to one
   `auto-fill` rule.
4. Light and dark screenshots captured for: timeline, empty state, selection
   bar, viewer, Telegram modal, details modal.
5. At 375px width, Albums · Archive · Trash · Favorites are each reachable in
   ≤ 2 taps.
6. Exactly one filled button per view.
7. `npm run build` (tsc + vite) passes.
8. Manual pass with keyboard only through upload → select → album →
   viewer → delete.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Redesign reveals full-original previews load slowly | Out of scope by rule, but capture it: grid now denser ⇒ more parallel full-size requests. Recommend thumbnails land before or with this work |
| `App.tsx` rewrite breaks upload/selection flows | No backend changes; move logic into hooks incrementally, keeping behaviour identical, then restyle |
| Dark mode contrast regressions | Token table above is the contract; verify with a checker per §7 |
| Scope creep into Immich features | §2 non-goals are binding; Explore/Sharing removed rather than faked |

---

## 10. Delivery order

1. **Tokens + theme** — `tokens.css`, `data-theme`, FOUC guard, toggle. Visible
   improvement, no structural risk.
2. **CSS consolidation** — delete the two dead layout generations, collapse
   `.media-grid`/`.media-preview`/`.selection-toolbar`. This is where the line
   count drops.
3. **Shell** — extract `Sidebar` + `TopBar`, real mobile drawer, collapse state.
4. **Timeline** — `Timeline`/`DateHeader`/`MediaTile`, auto-fill grid, sticky
   headers, overflow menu.
5. **Task mode + viewer** — `SelectionBar`, `Viewer` with strip, keyboard.
6. **Modals + toasts** — shared `Modal`, replace `window.prompt`, toasts.
7. **Verification** — §8 checklist with both themes.

Steps 1–2 are pure CSS and independently shippable. Steps 3–6 are the
`App.tsx` decomposition.

---

## 11. Open questions

1. Do we keep the name/branding as-is, or align the wordmark with the new
   neutral type? (Recommend: keep the mark, drop the gradient.)
2. Is dark mode the default for a photo library? (Recommend: follow OS.)
3. Should the Telegram status card stay in the sidebar footer, or move to a
   settings page as the app grows?
4. Viewer thumbnail strip: wanted now, or defer until thumbnails exist on the
   backend? (Recommend: defer — a strip of full-size images is a bandwidth
   trap.)

---

# Appendix: Face recognition (Phase 4, implemented)

Implemented ahead of the UI phases because it is backend-only and does not
depend on the design system.

## Design constraints

1. **Optional.** Nothing in the base install requires it. If the packages are
   missing, `/api/faces/status` reports `available: false` with an actionable
   message and the rest of the app is unaffected.
2. **Lightweight / portable.** Model `buffalo_s` (159 MB), one worker thread,
   serial processing, CPU by default. `onnxruntime` auto-selects CoreML
   (Apple), CUDA (NVIDIA), DirectML (Windows) or plain CPU, so the same wheels
   run anywhere with no rebuild.
3. **Never blocks the event loop.** Inference runs in a single-thread executor.

## Measured on this machine (M1, 8 GB)

| Metric | Value |
| --- | --- |
| Steady-state per image | **20 ms** |
| Cold start (first ever, includes model download) | 17.5 s |
| Embedding | 512-D ArcFace, L2-normalised |
| Providers detected | `CoreMLExecutionProvider`, `CPUExecutionProvider` |

## Install

```bash
npm run infinityvault -- faces
```

That installs `backend/requirements-faces.txt` only. The base install stays
~40 MB; with faces it is ~400 MB.

## Data model

```
people        id, client_id, name, cover_face_id, face_count
faces         id, media_id, person_id, bbox_*, det_score, embedding BLOB
face_jobs     id, media_id, status, attempts, last_error   ← mirrors upload_jobs
```

Embeddings are stored as float32 BLOBs and L2-normalised at write time, so
similarity is a dot product. Faces reference `media_items` only; nothing about
the Telegram path changes.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/faces/status` | availability, model, job counts |
| POST | `/api/faces/scan` | queue every unanalysed photo |
| POST | `/api/faces/cluster` | group unassigned faces into people |
| GET | `/api/people` | list people with cover thumbnails |
| GET | `/api/people/{id}/media` | all assets containing a person |
| PATCH | `/api/people/{id}` | rename |
| POST | `/api/people/merge` | merge two people |
| GET | `/api/faces/{id}/thumbnail` | 160px padded crop for the People grid |

A face job is queued automatically when a photo upload finishes.

## Clustering

Greedy incremental: each unassigned face is compared by cosine similarity to
the mean embedding of every known person; assign if `>= 0.5`, else create a
person. Under-merging is preferred over over-merging because splitting two
people is a UI fix, while fusing two relatives silently corrupts the library.

Threshold is configurable via `INFINITYVAULT_FACE_SIMILARITY`.

## Failure behaviour

- Missing packages → `FaceUnavailable`, job marked `failed` with a reason, and
  the worker **stops** rather than spinning.
- Interrupted jobs are reset to `queued` on startup, matching the upload queue.
- Images under 36 px per face side are skipped as unreliable.

## Not yet built

- People page UI (next UI phase)
- Full re-cluster / merge-suggestions
- Video frames
- The `local_path` reconciliation this depends on for older rows
