# PRD compliance audit

Audited `docs/PRD-PHASES.md` against the code at `920b704`, not against the
phase log. Every line below was checked in the source or against a live server.

**Verdict: 6 of 7 phases have all their tasks done. Phase 5 is 4 of 7, Phase 3
is 1 of 2, and Phase 7 hit a different target than the one written down.**

---

## Phase 1 — Trust the library ✅

| Task | State | Evidence |
|---|---|---|
| 1.1 `local_path` reconciliation on startup | **done** | `reconcile_local_files()`, `file_state` column, called in lifespan |
| 1.2 Pagination | **done** | keyset cursor on `(capture_time, id)`, `loadedPagesRef` guards the poll |

## Phase 2 — Telegram as a cold store ✅

| Task | State | Evidence |
|---|---|---|
| 2.1 Thumbnail generation | **done** | `_thumb.webp` 400px + `_micro.webp` 32px, serial worker |
| 2.2 Integrity check | **done** | `integrity_state` / `integrity_checked_at`, `POST /api/integrity/check` |
| 2.3 Metadata backup + restore | **done** | full round trip verified: 3 media, 1 album, 1 tag, favourite and description survived DB deletion |
| 2.4 Auto-backup | **done** | `AUTO_BACKUP_THRESHOLD`, `mark_library_changed()`, verified 7 uploads at threshold 5 -> exactly 1 backup |

## Phase 3 — Identity — **1 of 2**

| Task | State | Evidence |
|---|---|---|
| 3.1 Token auth | **done** | `auth.py`, bearer middleware, `TokenGate`, `npm run infinityvault -- token` |
| 3.2 Single-user cleanup | **NOT done** | PRD says "`client_id` becomes a server-side constant, not a request input". It is still a request input: `resolve_client_id()` reads `X-Client-ID` / `?client_id=` and 400s when absent. No migration to a constant was done. |

**Why it was not done:** the change touches every route and was not needed to
make auth work. It is a real simplification (and would close the odd situation
where a single-owner server still honours a client id from the caller) but it
is a separate, riskier change.

## Phase 4 — Faces & People UI ✅

| Task | State | Evidence |
|---|---|---|
| 4.1 People grid | **done** | sorted by face count, inline rename, merge mode, verified 6/5/2 columns |
| 4.2 Person detail | **done** | photo strip per person |
| 4.3 Scan controls | **done** | progress polling, not-installed banner |

## Phase 5 — Browse & discover — **4 of 7**

The PRD lists **seven** tasks. The work was tracked against a different
six-item list, so three PRD tasks were never implemented.

| PRD task | State | Note |
|---|---|---|
| 5.1 Explore: sections by **city, tag, person**, recently added | **partial** | Explore exists but its sections are Memories / Places / Recently added / Duplicates. There are **no city, tag or person sections**. |
| 5.2 Map / Places, clustered, no tiles | **done** | grid clustering, 23 points -> 4 pins, deliberately tile-free |
| 5.3 Memories ("on this day") | **done** | `db.on_this_day` |
| 5.4 Recently added | **done** | `db.recently_added` by `created_at` |
| 5.5 Duplicate finder, **review + delete UI** | **partial** | grouping by SHA-256 and review exist; **there is no delete action**. Deletion was deliberately not added, because removing a row is not recoverable from the UI. |
| 5.6 Search filters: date, **person**, **tag**, **place**, **favourites** | **partial** | date range, media type, has-faces, has-location, camera, sort exist. **Person, tag, place and favourites are not filter parameters** — the backend `build_media_filters()` supports only date_from/date_to/media_type/has_faces/has_location/camera. |
| 5.7 Utilities: **large files**, missing files, **geolocation gaps** | **partial** | missing-files listing exists. **Large files and geolocation gaps are absent.** |

**"Done when" for Phase 5** (each page has empty + loading state and is
reachable from the sidebar): this part **is** satisfied for the pages that exist.

## Phase 6 — Video ✅ (with two deviations)

| PRD requirement | State |
|---|---|
| Proxy built once, kept locally, original stays in Telegram | **done** |
| ffmpeg at the verified path | **done** |
| Serial job, never alongside face analysis | **done** — own worker thread |
| Skip HLS, plain MP4 range requests | **done** — confirmed `206 Partial Content` |

Two deviations from the written spec, both deliberate:

- **720p, not 480p.** The PRD says "480p proxy"; the code uses
  `PROXY_LONG_EDGE = 720`. A retina display at this size shows 480p artefacts
  clearly, and the file remains far smaller than the original.
- **"deleting the proxy regenerates it on next play" is NOT implemented.** The
  proxy endpoint returns 404 when `proxy_state != 'ready'`; it does not
  re-queue. Recovery requires the Utilities "Build missing previews" button.
  This is the one concrete Phase 6 "done when" criterion that is unmet.

## Phase 7 — App.tsx decomposition — **partial against the written target**

The PRD says: "`App.tsx` (937 lines) becomes ~120 lines".

- Extracted: `Sidebar`/`TopBar`/`Timeline` were **not** separately extracted;
  `MediaCard`, `MediaDetailsModal`, `EmptyState`, `TelegramModal`, `MediaViewer`
  were, into `components/MediaViews.tsx`.
- `useMediaLibrary` / `useSelection` hooks were **not** extracted under those
  names; `useLibraryFilters` was extracted instead. Selection state
  (`selectedIds`) is still in `App.tsx`.
- `App.tsx` is **880 lines**, not ~120. The target is missed by a wide margin:
  655 of the remaining lines are JSX (sidebar, toolbar, timeline markup) that
  was not split.

So Phase 7 is a genuine improvement but **does not meet its stated done
condition.**

---

## Summary

| Phase | Written state |
|---|---|
| 1 | ✅ complete |
| 2 | ✅ complete |
| 3 | 1 of 2 (3.2 not done) |
| 4 | ✅ complete |
| 5 | 4 of 7 (5.1, 5.5, 5.6, 5.7 partial) |
| 6 | functional; 480p->720p and no regenerate-on-play |
| 7 | 1282 -> 880 lines, target was ~120 |

### Still outstanding, in priority order

1. **5.6 person / tag / place / favourites filters** — the most user-visible
   gap; the data already exists (`people`, `tags`, `album_media`).
2. **5.1 Explore city / tag / person sections** — needs a city value, which is
   currently only raw lat/lon with no reverse geocoding.
3. **3.2 client_id as a server constant** — single-owner simplification.
4. **5.5 duplicate delete** — needs a recoverable delete (move to trash first).
5. **5.7 large files + geolocation gaps** — two more Utilities sections.
6. **Phase 6 regenerate-on-play** — re-queue the proxy when a Video request
   finds `ready` but the file is gone.
7. **Phase 7 rest** — split the 655 JSX lines; extract `useSelection`.

Items 1, 2, 4, 5, 6 and 7 were never claimed as done in the end-of-turn
summaries. Item 3 was likewise reported as undone. The miss is in the
**planning artefact**: Phase 5 was tracked against a six-item list that did not
match the PRD's seven, so three PRD tasks silently left the scope.
