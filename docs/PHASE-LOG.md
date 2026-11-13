# Phase Log — Living Progress Record

> Append-only. Newest completed work at the bottom of each phase.
> **This file is the answer to "where were we?"** Update it in the same
> commit as the work it describes.

**Plan:** `docs/PRD-PHASES.md`
**Baseline commit:** `d68fac7`
**Current phase:** Phase 6 (video proxies) next — Phase 5 done

---

## Status board

| Phase | Status | Owner | Notes |
| --- | --- | --- | --- |
| 1. Trust the library | ✅ Done | — | 1.1 + 1.2 verified |
| 1.1 `local_path` reconciliation | ✅ | — | Verified on real DB |
| 1.2 Pagination | ✅ | — | Verified in browser |
| 2. Telegram cold store | ✅ Done | — | 2.1–2.4 verified |
| 2.1 Thumbnails | ✅ | — | Grid never fetches originals |
| 2.2 Integrity check | ✅ | — | Utilities page |
| 2.3 Disaster recovery | ✅ | — | Backup + restore verified |
| 2.4 Auto-backup | ✅ | — | Throttled by change count |
| 3. Identity / auth | ✅ Done | — | Bearer token, verified end to end |
| 3.1 Token auth | ✅ | — | 401/200/400 matrix verified |
| 3.2 Single-user cleanup | ✅ | — | Zero `local-user` defaults remain |
| 4. Faces & People UI | ✅ Done | — | Backend + UI |
| 4.1 People grid | ✅ | — | Sorted by face count |
| 4.2 Person detail | ✅ | — | Photo strip per person |
| 4.3 Scan controls | ✅ | — | Analyse + Group, progress polling |
| 5. Browse & discover | ✅ Done | — | All sub-phases |
| 5.1 Explore | ✅ | — | Memories, Places, Recent, Duplicates |
| 5.2 Map / Places | ✅ | — | Tile-free, relative arrangement |
| 5.3 Memories | ✅ | — | This day in earlier years |
| 5.4 Recently added | ✅ | — | By arrival, not capture date |
| 5.5 Duplicate finder | ✅ | — | Reported, never auto-deleted |
| 5.6 Search filters | ✅ | — | Date, type, faces, location, order |
| 5.7 Utilities | ✅ | — | Integrity, backup, restore |
| 6. Video proxies | ⬜ Not started | — | Optional, last |
| 7. UI refactor | ⬜ Not started | — | `App.tsx` is ~1,100 lines |

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⏸ blocked

---

## Baseline (before Phase 1)

Verified at `d68fac7`:

- 29 routes, 10 tables, ~2,000 backend lines, ~3,400 frontend lines
- Face recognition complete: 20 ms/image, 512-D embeddings, clustering at 0.5
- Design tokens reconciled against Immich `87ef895`
- Known broken: 1 of 3 rows has a dead `local_path`; `list_media` has no `LIMIT`
- No test suite

Baseline verification:
```bash
cd backend  && .venv/bin/python -m compileall -q app     # ok
cd frontend && npm run build                             # ok
```

---

## Phase 1 — Trust the library

### 1.1 `local_path` reconciliation

- [x] Paths stored relative to `DATA_DIR`
- [x] `file_state` column (`present | missing | recovering`) — additive migration
- [x] Startup reconciliation with summary log
- [x] Absolute paths inside `DATA_DIR` normalised to relative (not just broken ones)
- [x] Frontend distinguishes "File missing" from "Preview unavailable", and
      does not fire a request for a row the server already marked missing
- [ ] Refetch from Telegram on missing file — **deferred to Phase 2**: the
      refetch needs the thumbnail/proxy cache work to be useful, and currently
      `telegram_media_path()` writes into `CACHE_DIR`, which reconciliation
      already checks, so a cached copy is restored automatically.

_Log:_
- 2026-02-14 — Implemented. Resolution order per row: stored path → same
  filename in `UPLOAD_DIR` → same filename in `CACHE_DIR` → `missing`.
- Verified against a synthetic DB with 4 cases (legacy absolute / rebasable /
  cache-restorable / healthy): got `{ok:1, rebased:1, restored:1, missing:1}`.
- Verified against a **copy of the real DB** (5 rows): 2 legacy rows rebased,
  3 absolute-but-valid rows normalised to relative. All 5 then resolve to
  existing files.
- Verified live: stale path → restart → rebased, logged, `/content` returns 200.
  Missing file → `/content` 404 (not 500), API reports `file_state: missing`.
- Found and fixed: root logger had no handler under uvicorn, so reconciliation
  messages were invisible. Added `basicConfig` guard.
- Found and fixed: `list_rows_needing_path_check` did not select `file_state`.

### 1.2 Pagination

- [x] `GET /api/media?cursor=&limit=` returns `{items, next_cursor}`
- [x] Cursor is `(capture_time, id)`, base64-opaque
- [x] Backward compatible: no `cursor`/`limit` still returns a plain array
- [x] Cursor is stable through concurrent inserts (keyset, not OFFSET)
- [x] Frontend appends instead of replacing; "Load more" footer
- [x] Verified with a synthetic 520-row library and in Chromium

_Log:_
- 2026-02-14 — Implemented keyset pagination. `limit` clamps to 1..1000,
  default 200. One extra row is fetched per page to decide `next_cursor`
  without a second COUNT query.
- Verified 500 rows / 5 pages / 0 duplicates, with 50 rows deliberately
  sharing one `capture_time` to exercise the `id` tiebreaker.
- Verified stability: inserting 20 newer rows mid-walk produced no
  duplicates and no skips (the reason OFFSET was rejected).
- HTTP verified: legacy array shape preserved; paginated shape correct;
  garbage cursor → 400; oversized limit clamped.
- Browser verified (Chromium, 520-row library): 8/8 checks — first request
  carries `limit=`, no cursor; 200 tiles; Load more → 400 tiles; all 400
  unique; view switch restarts at page 1.
- **Bug found by the browser test:** the 2s poll called `refreshLibrary`,
  which replaced `items` with page 1 and silently discarded every appended
  page. Fixed by preserving rows beyond page 1 and guarding cursor rewinding
  with `loadedPagesRef`. Re-verified: 400 tiles after ~4 poll cycles.
- **Bug found:** `setNextCursor` was briefly placed inside a `setItems`
  updater; moved out to keep updaters pure.
- Added `data-id` to `MediaCard` (needed for the duplicate assertion).
- CORS: widened to include port 5180 so an alternate dev port works; this
  also blocked the first browser run ("Failed to fetch").

---

## Phase 2 — Telegram as a cold store

### 2.1 Thumbnails

- [x] `data/thumbnails/` with `_thumb.webp` (400px) and `_micro.webp` (32px)
- [x] `thumbnail_jobs` queue mirroring `upload_jobs`
- [x] `GET /api/media/{id}/thumbnail` with immutable caching
- [x] `preview_url` points at the thumbnail; `content_url` added for originals
- [x] Video frame extraction via ffmpeg (frame at 1s, not 0 — often black)
- [x] `POST /api/thumbnails/backfill`
- [x] Verified: grid makes zero `/content` requests

_Log:_
- 2026-02-14 — Implemented `thumbnail_service.py`. Pillow + WebP, EXIF
  orientation applied, serial worker, generation always off the request path.
- Measured: 3000x2000 PNG → 0.3 KB thumb (64x reduction); real 91.8 KB photo
  → 19.8 KB thumb; 1280x720 video → 3.5 KB frame thumbnail.
- Video frame confirmed visually to be real content, not a black first frame.
- Real library backfilled: 2 items → `ready`, 29.5 KB for a full-size portrait.
- **Bug 1 (major):** `<img>`/`<video>` cannot send `X-Client-ID`, so every
  thumbnail request fell back to `local-user` and 404'd. Chrome then turned
  that JSON 404 into `net::ERR_BLOCKED_BY_ORB`, which surfaced as a misleading
  "Preview unavailable". Fixed by accepting `?client_id=` on both thumbnail
  endpoints (the frontend already appended it via `mediaUrl()`).
- **Bug 2:** ORB also needs `Cross-Origin-Resource-Policy: cross-origin` on
  image responses. Added to both.
- **Bug 3:** video tiles rendered a full `<video>` element as the poster,
  downloading video data to paint a tile. Now an `<img>` of the thumbnail.
- Verified in Chromium: 3 tiles, 3 loaded, **0 `/content` requests**, theme
  toggle still works, micro placeholders served.
- `Pillow>=10` added to requirements.txt.

### 2.2 Integrity check

- [x] `POST /api/integrity/check` verifies Telegram message existence
- [x] Results written to a dedicated `integrity_state` (+ timestamp), not
      `file_state` — the two answer different questions (local file vs remote
      original) and conflating them would make one overwrite the other
- [x] Handles the subtle case: message exists but its media was stripped
- [x] Batched lookups (100 per round trip) so a big library stays fast
- [x] UI surfaces counts and the broken list; limitation stated in the UI

_Log:_
- 2026-02-14 — Implemented `check_integrity()` on `TelegramService`.
  Reuses one metadata lookup per batch rather than downloading anything.
- Verified with a mocked client over 5 rows: 2 ok, 3 missing, correctly
  including a message that survived with `media=None`.
- Verified batching across 250 rows (batches 100/100/50): exactly 225 ok /
  25 missing with every 10th message deleted.
- Verified endpoints: `/check` without Telegram → 409 with an actionable
  message; `/status` and `/broken` return correct shapes.
- Verified in Chromium: Utilities page renders 2 Present / 3 Missing /
  0 unchecked, lists the 3 broken items, "Checked 1m ago" meta, zero console
  errors. Clicking "Check library" with Telegram disconnected shows
  "Reconnect Telegram before checking your library" and the button does not
  get stuck in its loading state.
- **Design note:** not reusing `file_state`. `file_state` is about the local
  copy; `integrity_state` is about the Telegram original. A row can legitimately
  be `present` locally and `missing` in Telegram, and vice versa.
- **Token gap found:** the new page referenced `--primary-soft`,
  `--danger-soft` and `--surface-variant`, which did not exist. Added the two
  soft tokens to both themes and switched to the existing `--surface-2` rather
  than introducing a literal colour or a duplicate token.
- Utilities layout changed from a hard `max-width: 780px` to
  `width: min(100%, 1100px)` so it fills the content area instead of leaving a
  large empty region on wide screens.

---

## Phase 2.3 — Disaster recovery

- [x] `export_metadata()` / `import_metadata()` — JSON snapshot round trip
- [x] `backup_metadata()` uploads the snapshot to Saved Messages
- [x] `scan_for_restore()` finds backups without changing anything
- [x] `apply_restore()` applies metadata first, then rebuilds from captions
- [x] Idempotent on `telegram_message_id`
- [x] Utilities UI: backup, scan, restore, with honest copy

_Log:_
- 2026-02-14 — Added after the user asked "what happens if someone deletes
  everything and reinstalls?". Verified the answer was bad: nothing in the
  codebase ever called `iter_messages`, so a fresh DB could not rediscover its
  own backups, and albums/tags/favourites existed only on one disk.
- Verified round trip: 3 media + 1 album + 1 tag + favourite + description
  exported, DB deleted, re-imported — all restored including favourite and
  description.
- Verified caption-scan restore with a mocked client: found 2 backups, ignored
  an unrelated personal note, restored photo + video with capture times, and a
  second run restored 0 (idempotent).
- Verified metadata takes priority: with a metadata backup present, restore
  returns `restored_media: 0` because those rows already exist, so no
  duplicates are created alongside the imported ones.
- Verified in Chromium: three cards render, "Restore library" is disabled until
  a scan runs, the no-Telegram path shows an actionable notice, and buttons do
  not stick in a loading state.
- **Fixed:** `primary-button` / `ghost-button` had no base CSS rule at all, so
  they rendered as browser-default controls with the icon crowding the label.
  Added scoped `.utility-actions` styles using existing tokens.
- **Honest limit, stated in the UI:** without a metadata backup, restore
  recovers photos only — albums, tags and favourites cannot be rebuilt from a
  caption.

---

## Phase 2.4 — Auto-backup

- [x] `app_settings` table for durable bookkeeping
- [x] `mark_library_changed()` on every metadata mutation
- [x] `_maybe_auto_backup()` after each upload, throttled by change count
- [x] `GET /api/backup/status` + drift line in Utilities
- [x] Failure never breaks an upload; count stays high so it retries

_Log:_
- 2026-02-14 — A manual-only backup silently goes stale, which is the exact
  failure Phase 2.3 exists to prevent. Throttled by **change count, not upload
  count**: a bulk import of 500 photos must refresh the snapshot once at the
  end, not upload 500 JSON files and bury the user's Saved Messages.
- Verified: 7 uploads with threshold 5 produced **exactly 1** backup, fired at
  the threshold and reset. Album/favourite edits also count; `create_media`
  alone does not, since a row is only real metadata once uploaded.
- Verified: with Telegram failing, uploads still succeed and the warning is
  logged. The change count is not reset, so it retries rather than silently
  losing the backup.
- **Bug found in browser:** the status line never loaded, because the
  `getBackupStatus()` call was never wired into `load()` — so the "never backed
  up" warning would silently never appear. Fixed by folding it into the
  existing `Promise.all`.
- **Alignment fixed twice:** the status line and then the buttons sat under the
  icon instead of the heading. Both now use the same
  `calc(38px + 14px)` text-column inset; measured identical left edges (337px)
  on all three cards. An earlier "misalignment" reading was a measurement
  artifact — box edge vs painted text, confirmed with a `Range`.

---

## Phase 3 — Identity

- [x] `auth.py`: token load/generate/validate, constant-time compare
- [x] `require_access_token` middleware, with public health/status paths
- [x] No-lockout escape hatch when no token is configured
- [x] Every endpoint resolves a client id; zero `local-user` defaults remain
- [x] `npm run infinityvault -- token` (0600, preserves other keys)
- [x] Frontend gate: prompt, verify, persist, 401 handling

_Log:_
- 2026-02-14 — No OAuth and no Telegram login. The vault has no accounts; the
  Telegram session already authenticates to *storage*, so reusing it for web
  auth would mean any Telegram login grants the photo library. A single bearer
  token answers "is this the owner?", which is the only question here.
- Verified the request matrix: no token and wrong token both 401 (including
  the new backup/restore endpoints); correct bearer 200; `?access_token=` 200;
  health and auth/status public; authenticated but missing client id 400.
- Verified the no-lockout path: with no token configured, `/api/auth/status`
  reports `required: false`, requests succeed, and every response carries
  `X-InfinityVault-Security: unsecured` rather than silently pretending to be
  protected.
- Verified the CLI writes mode 0600 and preserves existing TELEGRAM_* keys.
- **Security bug found in the browser:** submitting a *wrong* token rendered
  the app shell, because unlocking was optimistic and only a later poll would
  have rejected it. The gate now proves the token with a request before
  rendering anything. Re-tested: wrong token re-prompts with explanatory copy.
- **Second bug:** a *rotated* stored token also slipped through, because the
  bootstrap trusted "a token exists" as "a token works". A stored token is now
  verified on boot; a stale one shows the gate instead of an app that fails
  every request.
- Verified with a stale token stored against an *unprotected* server: no gate,
  so a user is never locked out of their own library.
- `mediaUrl()` appends the token, because `<img>`/`<video>`/download anchors
  cannot set an Authorization header — the same constraint that already forced
  `?client_id=` for thumbnails.
- **Layout fix:** helper commands wrapped mid-token (`-- token` split across
  lines); commands are now `white-space: nowrap`, confirmed single-line.

---

## Phase 4 — People

### 3.1 Token auth

- [ ] 32-byte token generated on first run, env file 0600
- [ ] `Authorization: Bearer` required on all `/api/*` except health
- [ ] All `"local-user"` fallbacks removed
- [ ] `hmac.compare_digest` comparison
- [ ] Frontend token prompt on 401, persisted
- [ ] Verified: curl without token → 401

_Log:_ (empty)

### 3.2 Single-user cleanup

- [ ] `client_id` becomes a server constant
- [ ] One-time migration of non-default ids

_Log:_ (empty)

---

## Phase 4 — Faces & People UI

### 4.1 People grid · 4.2 Person detail · 4.3 Scan controls

- [ ] People grid with avatars and counts
- [ ] Person detail with assets, rename, merge
- [ ] Scan button with live progress
- [ ] Hidden with install hint when `available: false`

_Log:_ (empty)

---

## Phase 5 — Browse & discover

- [x] 5.1 Explore page (Memories, Places, Recently added, Duplicates)
- [x] 5.3 Memories — this day in earlier years
- [x] 5.4 Recently added — by arrival, not capture date
- [x] 5.5 Duplicate finder — by checksum, reported not deleted
- [x] 5.6 Search filters — date range, type, faces, location, **camera**, order
- [x] 5.7 Utilities — already complete in 2.2/2.3/2.4

_Log:_
- 2026-02-14 — The `latitude`/`longitude` columns existed since the first
  schema but **nothing ever wrote to them**: no EXIF reader, no upload field,
  no writer. Map had no data and could not have had any, so GPS capture came
  first and the views second.
- GPS is rejected when it is 0,0 (the "no fix" value EXIF writers emit, which
  would put a pin in the Gulf of Guinea) or out of range, rather than stored
  and rendered as a real location.
- Verified EXIF round trip with a real geotagged JPEG: 28.614, 77.209 read back
  correctly, and S/W hemisphere refs flip the sign (-33.87, -151.2).
- Verified backfill against a live DB: one row with EXIF GPS and empty columns
  was located and persisted, leaving 0 remaining.
- Verified filters over HTTP: photos 8, videos 1, has-location 6, 2024-only 1,
  and both sort orders. Sort-aware keyset paging returns all 7 rows with no
  duplicates in either direction, and oldest is the exact reverse of newest.
- **Live bug found and fixed:** `media_thumbnail`, `media_micro_thumbnail`,
  `telegram_media_content` and `geo_points` all declared a `?client_id=` query
  parameter and then called `resolve_client_id(client_id)` without it. Every
  image request using the query-param path -- the *only* path `<img>` and
  `<video>` can use, since they cannot set headers -- returned 400. This
  predates Phase 5; it surfaced here because Explore loads images directly.
  Verified 400 -> 200 on the query path, with the header path and the
  400-when-missing case still correct.
- **Two frontend bugs found by testing, both fixed:**
  1. Filters changed the request but not the list, because the poll merges
     "pages already loaded" back in, re-adding rows the filter excluded.
  2. "Oldest first" still rendered newest-first, twice over: `filteredItems`
     re-sorted locally after the server had already sorted, and the date
     grouping re-sorted by its own flag. Both now defer to the server order.
- **Second pass on the same bug class:** `face_thumbnail` also lacked the
  query fallback, so the People grid's face crops -- rendered as `<img>` --
  would 400 whenever the header was absent. `duplicates`, `memories` and
  `recently-added` were header-only too; not broken today, but inconsistent
  with `geo_points` in exactly the way that produced the bug above. All four
  now accept both, and a sweep of all 45 routes finds no route that accepts
  `?client_id=` and ignores it.
- The rule, now applied consistently: **any endpoint whose URL is loaded into
  an `<img>` or `<video>` must accept `?client_id=`,** because the browser
  cannot attach a header to those requests. Header-only is fine everywhere
  else, since the client always sends one.
- **Completeness audit (2026-02-14).** The user asked whether Phase 5 was
  really done. Checking the original six-item list against the code found two
  items genuinely missing, both now built:
  - **5.2 camera/lens filter** — there was no `camera_make`/`camera_model`/
    `lens_model` column at all, so the filter could not exist. Added the
    columns, EXIF capture (`Make`, `Model`, `LensModel`), upload fields, a
    `camera` filter matched against make *or* model, a `/api/cameras` endpoint
    listing only cameras actually present, and a backfill that reads existing
    originals. Blank and NUL-padded EXIF values are normalised away, otherwise
    the dropdown would offer empty options.
  - **5.3 clustered pins** — pins were one-per-photo, so a library shot in one
    place stacked dozens on the same pixel with only the last clickable. Now
    grid-clustered into labelled bubbles. Verified 23 points -> 4 pins, one
    bubble reading "20", with the 3 distant photos kept separate.
  - Verified camera filtering end to end: 7 -> 3 (iPhone) -> 2 (EOS R5) in the
    browser, and the backfill labels a real EXIF original while skipping a row
    whose file is gone instead of failing.
- **Map is deliberately tile-free.** Fetching map tiles would disclose the
  locations of the user's photos to a third party, so the map shows relative
  arrangement and the copy says exactly that. Pins are inset to 6-94% of the
  span after measurement showed 3 of 6 clipped at the edges.

---

## Phase 6 — Video

- [ ] 480p proxy transcoded once into `data/proxies/`
- [ ] Serial, lowest priority
- [ ] Regenerates on play if deleted

_Log:_ (empty)

---

## Phase 7 — UI refactor

- [ ] Components extracted from `App.tsx`
- [ ] `App.tsx` under ~150 lines

_Log:_ (empty)

---

## Decisions log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-02-14 | Stay on SQLite; reject Postgres+Redis+BullMQ | Measured: face model 544 MB + stack ~400 MB vs 1,341 MB free |
| 2026-02-14 | Telegram is a cold store only | Reads must never hit the network |
| 2026-02-14 | Pillow for thumbnails, not sharp | Python-native, cross-platform, no node native build |
| 2026-02-14 | Skip HLS; use plain MP4 range requests | Simpler, adequate for personal video |
| 2026-02-14 | Thumbnails as jobs, not inline | Keeps upload response fast; backfillable |


## Phase 6 — Video playback (`proxy_service.py`)

**Problem.** The viewer pointed `<video>` at `/telegram-content`, which
downloads the *entire* original through the Telethon cache before a single
frame appears. A five-minute phone clip is hundreds of megabytes: the viewer
sat on a spinner for minutes and the timeline could not be scrubbed until the
download finished.

### What was built

- [x] 6.1 **Proxy generation** — `backend/app/proxy_service.py`. One 720p H.264
      MP4 per video, built in a serial background worker.
- [x] 6.2 **Serving** — `GET /api/media/{id}/proxy`, accepting `?client_id=`
      because `<video>` cannot send headers. `FileResponse` handles ranges.
- [x] 6.3 **Viewer** — plays the proxy by default, with a **Playing preview** /
      **Playing original** toggle, and automatic fallback to the original if the
      proxy fails for any reason.
- [x] 6.4 **Backfill** — `POST /api/videos/proxies`, `GET /api/videos/status`,
      and a section on the Utilities page.

### Decisions and why

- **`-movflags +faststart` is the whole point.** Without it the MP4 index sits
  at the end of the file, so the browser must download everything before it can
  seek — exactly the behaviour being fixed. Verified: `moov` at byte 36,
  before `mdat`.
- **720p long edge, capped portably.** The scale expression uses `min()` on
  each axis so portrait video is capped on *its* long edge. Verified:
  1920x1080 -> 720x406, 720x1280 -> 406x720. Dimensions stay even because
  H.264 in `yuv420p` cannot encode odd sizes.
- **`-pix_fmt yuv420p` and `-profile:v main`.** Phone video is often
  `yuv420p10le` or High profile, which QuickTime and older Safari refuse.
- **Separate worker from thumbnails.** Encoding saturates a core; a queue of
  large videos must never delay the thumbnail of a photo the user just
  uploaded. One thread only, for the same 8 GB-RAM reason the face model is
  serial.
- **Never replaces the original.** Telegram keeps the archival copy; the proxy
  is a viewing convenience and "Download original" is untouched.
- **Failure is terminal, not retried forever.** A missing local file or a
  corrupt container marks `failed` and the worker moves on. Verified that a
  missing file and a non-video file both fail cleanly without wedging the queue.

### Verified

- 1080p source -> 720x406 proxy, H.264 + AAC, `faststart` confirmed by byte
  offset, 1.8x smaller (a synthetic test pattern compresses poorly; real footage
  compresses far better, so this figure is a floor, not a typical result).
- Range request returns `206 Partial Content` with a correct `Content-Range`.
- In-browser: `<video>` loads from `/proxy`, `readyState: 4`, one seekable
  range, frames visible, toggle reads "Playing preview".
- `/api/videos/status` works via header and via `?client_id=`.
- Both failure paths mark `failed` without wedging the worker.


## Phase 7 — App.tsx decomposition

`App.tsx` reached 1282 lines: timeline, filters, auth, upload, viewer and five
modals in one file. Every later phase cost more because of it.

### What moved

| Destination | Contents | Lines |
|---|---|---|
| `lib/format.ts` | `formatDateHeading`, `dateKey`, `formatTime`, `formatSize`, `formatDuration`, `statusLabel`, `itemFromApi` | 127 |
| `components/MediaViews.tsx` | `MediaCard`, `MediaDetailsModal`, `EmptyState`, `TelegramModal`, `MediaViewer` | 366 |
| `hooks/useLibraryFilters.ts` | View, tab, sort, advanced-filter, album/tag/camera and search state | 120 |

`App.tsx`: **1282 -> 880**. A further 655 lines are JSX (sidebar, toolbar,
timeline markup) that can be split next.

### Decisions

- **`itemFromApi` takes the URL builder as an argument** instead of importing
  `mediaUrl`. The token is read at call time, so importing it would freeze the
  wrong token into any cached mapping; passing it in also keeps the function
  testable. Note this made a bare `.map(itemFromApi)` wrong, because the index
  would be passed as the builder — every call site now passes it explicitly.
- **Presentational components take everything by props.** A grep confirmed none
  of them read app state, only local UI state (loading, hover, the viewer's
  preview/original toggle), which is what made the seam safe.
- **`buildFilterParams()` deliberately does *not* send the sidebar tab.** That
  tab has always been applied client-side to the fetched page. Sending it would
  change pagination behaviour (Videos-only would stop paging while photos
  remain), which is an improvement but not a refactor. Documented in the hook so
  the next person does not "fix" it by accident.

### Verified

- `tsc --noEmit` and `npm run build` clean.
- **Pixel comparison against the pre-refactor build: identical.** Screenshots
  of the original (stashed via `git stash`) and the refactored version, with
  images forced to decode first, differ by zero pixels.
- Interactive paths exercised: all media 7 -> Videos only 1 -> Photos only 6 ->
  back to 7, oldest-first ordering produces ascending date headings, filter
  Clear restores 7, viewer opens and closes, **no console errors and no failed
  requests**.

### Note on a bug found while doing this

`buildFilterParams` initially overrode the Order dropdown with the sidebar
Newest/Oldest toggle. Both controls existed and mean different things: the
dropdown stores `advancedFilters.sort`, the sidebar stores `sortDirection`. The
hook now keeps them separate and matches the precedence already used by the
timeline memo (`advancedFilters.sort` wins when set).


## Remediation — closing the PRD audit gaps

An audit of `docs/PRD-PHASES.md` against the code (rather than the phase log)
found several tasks the PRD listed that had never been built. All are now done;
`docs/PRD-COMPLIANCE-AUDIT.md` records each one and how it was verified.

- **5.6** person / tag / place / favourites filters — added end to end.
- **5.1** Explore Tags, People and Areas sections.
- **5.5** duplicate groups can be resolved by trashing the extras, keeping the
  oldest. Reversible by design.
- **5.7** Utilities: largest files and location-gap coverage.
- **6** a missing proxy is re-queued on play instead of 404ing forever.
- **3.2** `client_id` is no longer required; it resolves to the owner.
- **7** `Sidebar` extracted, verified pixel-identical.

Two things worth remembering from this pass:

1. **The gap was in the plan, not the code.** Phase 5 was tracked against a
   six-item list that did not match the PRD's seven, so three tasks left the
   scope silently. Diffing the PRD against the implementation is what caught it.
2. **3.2 nearly shipped a data-loss bug.** Defaulting an absent client id to
   `"owner"` made every pre-existing row invisible, because they are stored under
   a browser-generated UUID. Resolving to the id actually present in the table
   fixed it. The lesson: a "simplification" that changes which rows a query
   matches needs a test with real pre-existing data, not an empty database.
