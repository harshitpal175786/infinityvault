# Phase 2 — Photos Timeline and Media Grid

Scoped by audit of what already works, not by assumption. The brief says not to
redesign screens that are already complete, and much of Phase 2 already exists.

## Already working (verified in code — do not rebuild)

| Requirement | Where |
|---|---|
| Chronological timeline + date grouping | `App.tsx` `groupedItems`, `.date-group` |
| Responsive tile sizing | `.media-grid` `auto-fill minmax(--tile-target, 1fr)` |
| Lazy loading | `MediaCard` `loading="lazy"` + micro-thumbnail blur-up |
| Infinite scrolling | `useInfiniteScroll` (Phase 1 predecessor work) |
| Hover interactions | `.media-card:hover` overlay actions |
| Single + multi selection | `selectedIds: Set<string>`, `toggleSelected` |
| Sorting | "Newest first" dropdown + sidebar sort precedence |
| Filtering | `useLibraryFilters`, `buildFilterParams` |
| Favorites | `toggleFavorite`, `is_favorite` |

## Genuinely missing (the actual Phase 2 work)

1. **Context menu** — zero `onContextMenu` handlers anywhere. Right-click does
   nothing today. Needs a `ContextMenu` primitive (`.menu` CSS exists from
   Phase 1 but has no React component).
2. **Select all / range select** — `selectAll` has 0 references. Shift-click for
   a range is the standard expectation and is absent.
3. **Loading state** — first load renders nothing; there is no skeleton and no
   distinction between "loading" and "empty". On a 378-item library the first
   paint is a blank area.
4. **Error state** — a failed fetch writes to a toast but leaves the grid empty
   with no recovery affordance.
5. **Justified grid** — currently uniform squares with `object-fit: cover`. The
   brief asks for "masonry or justified". Changing tile aspect is a visual
   change to a completed screen, so this is the one item to decide deliberately.

## Decision on the grid layout

The brief permits **either** masonry/justified **or** the current approach, and
rule 8 forbids inconsistent redesign of completed screens. A justified grid
changes tile heights and therefore every scroll position and the pixel-identical
baseline established in Phase 1.

**Recommendation: keep uniform square tiles.** They are Immich's default, they
align cleanly, and `object-fit: cover` means no distortion. I will implement
everything else and flag this as an explicit choice rather than silently doing
neither.

## Plan

1. `ContextMenu` primitive + wire right-click on `MediaCard`.
2. Shift-click range selection; select-all / clear in the selection bar.
3. `Skeleton` grid for first load (reuses the Phase 1 primitive).
4. Error state with a retry action.
5. Keyboard: arrow-key movement within the grid, Enter to open.

## Verification

- Context menu opens at the pointer, closes on Escape and outside click.
- Range select: click A, shift-click C selects A..C.
- Skeleton appears before data and is replaced, with no layout shift.
- Forced fetch failure shows a retry that recovers.
- Pixel diff on the grid stays empty (no unintended visual change).
- Build + tsc clean, no console errors.
