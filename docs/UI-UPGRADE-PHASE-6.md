# Phase 6 — Search and Filtering

Audited first. The filter UI is already complete, so this phase is narrower than
its title.

## Already working (verified — do not rebuild)

| Capability | Evidence |
|---|---|
| Advanced filter bar | `App.tsx` `filter-bar`, 11 controls |
| Date range | `dateFrom` / `dateTo` date inputs |
| Media type | photo / video select |
| Has faces / no faces | `hasFaces` |
| Person filter | `personId`, populated from `/api/people` |
| Tag filter | `tagId` |
| Place (folder/caption) | `place` |
| Favourites | `favorite` |
| Location | `hasLocation` |
| Camera | `camera`, populated from `/api/cameras` |
| Sort | newest / oldest |
| Active filter count + clear | `activeFilterCount`, `clearAdvancedFilters` |
| Server-side filtering | 16 params on `GET /api/media` |

## Correction: search IS already debounced

My first read of the code was wrong and I recorded it wrongly before checking.

`App.tsx` already debounces the input into `searchTerm` with a 250 ms timer
before any fetch happens. Measured behaviour confirms it: typing `photo` at a
realistic 90 ms per character fires **one** request, not five. The 5-request
result I saw came from typing at *slower* than the debounce window, where each
character legitimately settles into its own query — that is correct behaviour,
not a defect.

I also added a second `useDebounced` hook before noticing the existing one, then
measured that it changed nothing because `searchTerm` had already settled by the
time it ran. It was removed rather than left in as dead code.

## Plan (revised after the audit)

1. ~~Debounce search~~ — already implemented upstream.
2. ~~Search suggestions from people and tags~~ — **dropped**: this vault has
   151 people and **0 of them named**, and **0 tags**. Suggestions would be
   permanently empty. Building a control that can never show anything is the
   kind of fake UI the brief forbids. Revisit once names exist.
3. **Search-specific empty state** — when a query matches nothing, name the
   query, mention active filters, and offer a clear action, instead of showing
   the generic "your timeline starts here" message over a full library.

## Deliberate scope limits

- **No full-text index (FTS5).** Search is `LIKE '%term%'` on name, description
  and folder. On 378 rows it is instant. Adding FTS5 now would need a contentless
  table, triggers on three tables and a rebuild step, for no measurable gain at
  this size. Noted as the known ceiling, not silently ignored.
- **No natural-language parsing** (`camera:Sony before:2024`). Immich has it;
  it needs a query grammar, and the filter bar already covers those fields.
- **Search does not match people or tag names server-side.** The suggestions
  in step 2 route to the existing `personId`/`tagId` filters instead, which is
  honest about what the backend actually does.

## Verification

- Typing at normal speed fires one request per settled query.
- A query with no matches shows a search-specific empty state naming the query,
  with a working clear action.
- The filter bar still composes with search.
- Filters still compose with search; grid pixel-identical when idle; tsc and
  build clean.
