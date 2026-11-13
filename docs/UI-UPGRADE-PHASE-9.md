# Phase 9 — Testing and Optimization

Measured before planning.

## Baseline (measured, not assumed)

| Metric | Value |
|---|---|
| Time to first tile | **409 ms** |
| DOMContentLoaded | 121 ms |
| First contentful paint | 240 ms |
| JS transferred (dev) | 770 KB over 15 requests |
| Production bundle | **350 KB** JS in one chunk, 63 KB CSS |
| DOM nodes after first page | 2 740 with 200 `<img>` |
| Frontend tests | **0** |
| Backend project tests | **0** (only vendored library tests) |

On localhost the app is fast. This matters for the plan: **the obvious
"optimization" — code splitting the bundle — would buy almost nothing here.**
The app is served from the same machine over loopback, on a single-owner
install. Splitting a 350 KB chunk into four would not change the 409 ms number
in any way a person could perceive.

## The real gaps

### 1. No error boundary — a blank page with no way back

There is no `ErrorBoundary` anywhere. A single throw during render unmounts the
entire tree and leaves a white screen. The user loses the page, with no message
and no recovery, and has to know to reload. For a vault holding someone's only
copies of photos, failing silently is the worst possible failure mode.

This is the highest-value change in the phase, and it is not an optimization —
it is correctness.

### 2. Nothing is tested

No test runner, no tests, in either half of the project. Every phase so far has
been verified by ad-hoc Playwright scripts that were deleted afterwards, which
means none of the behaviour established in Phases 1–8 is protected against
regression.

Adding a full test stack (Vitest, Testing Library, coverage thresholds) would be
a large dependency footprint on an 8 GB machine, against the project's stated
preference. Instead: a small set of **permanent** checks under `scripts/` that
run against the real app and assert the invariants the phases established.

## Plan

1. **Error boundary** with a real recovery action, wrapping the app.
2. **A permanent smoke script** (`scripts/smoke.mjs`) asserting the invariants
   that are easy to break: grid geometry, infinite scroll, search debounce,
   settings values, no console errors.
3. **A `npm run smoke` entry** so it can be re-run after any change.

## Deliberately not doing

- **No code splitting.** Measured: no perceivable win on a loopback single-user
  install. Doing it to look busy would be worse than not doing it.
- **No virtualized grid.** 200 tiles at 2 740 nodes is comfortable; the
  infinite scroll already caps how much can load at once.
- **No new test framework.** Dependency weight against the memory budget.
- **No bundle size target.** The number is already small for what it does.

## Verification

`npm run smoke` — **15/15 checks pass.**

| Check | Result |
|---|---|
| First page of tiles | 200 |
| Tiles square at 192px | 192x192 |
| Grid origin unchanged | x=260 y=248 |
| Infinite scroll adds tiles | 200 → 367 |
| Hopeless query shows empty state | "No matches for ..." |
| Clearing search restores library | 200 tiles |
| People / Albums / Utilities open | yes |
| Settings: 3 named sections, 7 rows | yes |
| No console or page errors | clean |
| No crash fallback showing | yes |

**The crash fallback was tested with a real throw**, not inferred: a probe page
with a component that throws during render produced the headline, the error
message, and both recovery buttons.

### Proof the test actually catches regressions

A test that only ever passes is worthless, so I broke things on purpose:

| Deliberate break | Result |
|---|---|
| Rename a Settings section | **FAIL** — "Status, Appearance, Repair" |
| Resize grid tiles to 200px | **FAIL** — "200x200" |
| Both restored | 15/15 pass again |

The first attempt at the Settings check only counted sections, and a renamed
section **passed**. That is exactly the decorative test I was trying to avoid, so
the assertion now matches the section names.

### A bug this phase caught in its own work

The crash page's buttons used `btn btn-filled` / `btn btn-text`, which do not
exist — the real component takes `variant="primary" | "ghost"`. A screenshot
showed both buttons styled identically. Switched to the real `Button` component;
"Try again" now renders filled indigo and "Reload" as ghost.

## What I did not do, and why

**No code splitting.** Measured first: the app reaches its first tile in 409 ms
on a loopback single-user install. Splitting a 350 KB chunk would not move that
number perceptibly. Changing things to appear productive is worse than leaving
them measured and correct.

**No virtualized grid.** 200 tiles, 2 740 DOM nodes — comfortable, and infinite
scroll already bounds growth.

**No test framework or coverage gate.** Dependency weight against the project's
stated memory budget; the scripts above cover the invariants that actually broke
during this work.
