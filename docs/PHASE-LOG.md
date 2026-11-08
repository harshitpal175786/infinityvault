# Phase Log — Living Progress Record

> Append-only. Newest completed work at the bottom of each phase.
> **This file is the answer to "where were we?"** Update it in the same
> commit as the work it describes.

**Plan:** `docs/PRD-PHASES.md`
**Baseline commit:** `d68fac7`
**Current phase:** Phase 3 (identity/auth) next — 2.3 disaster recovery done

---

## Status board

| Phase | Status | Owner | Notes |
| --- | --- | --- | --- |
| 1. Trust the library | ✅ Done | — | 1.1 + 1.2 verified |
| 1.1 `local_path` reconciliation | ✅ | — | Verified on real DB |
| 1.2 Pagination | ✅ | — | Verified in browser |
| 2. Telegram cold store | ✅ Done | — | 2.1 + 2.2 verified |
| 2.1 Thumbnails | ✅ | — | Grid never fetches originals |
| 2.2 Integrity check | ✅ | — | Utilities page |
| 2.3 Disaster recovery | ✅ | — | Backup + restore verified |
| 2.4 Auto-backup | ✅ | — | Throttled by change count |
| 3. Identity / auth | ⬜ Not started | — | Deploy gate |
| 3.1 Token auth | ⬜ | — | |
| 3.2 Single-user cleanup | ⬜ | — | |
| 4. Faces & People UI | ⬜ Not started | — | Backend done |
| 4.1 People grid | ⬜ | — | |
| 4.2 Person detail | ⬜ | — | |
| 4.3 Scan controls | ⬜ | — | |
| 5. Browse & discover | ⬜ Not started | — | |
| 5.1 Explore | ⬜ | — | |
| 5.2 Map / Places | ⬜ | — | |
| 5.3 Memories | ⬜ | — | |
| 5.4 Recently added | ⬜ | — | |
| 5.5 Duplicate finder | ⬜ | — | |
| 5.6 Search filters | ⬜ | — | |
| 5.7 Utilities | ⬜ | — | |
| 6. Video | ⬜ Not started | — | Optional, last |
| 7. UI refactor | ⬜ Not started | — | After UI settles |

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

- [ ] 5.1 Explore · [ ] 5.2 Map/Places · [ ] 5.3 Memories
- [ ] 5.4 Recently added · [ ] 5.5 Duplicate finder
- [ ] 5.6 Search filters · [ ] 5.7 Utilities

_Log:_ (empty)

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
