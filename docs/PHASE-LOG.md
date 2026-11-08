# Phase Log — Living Progress Record

> Append-only. Newest completed work at the bottom of each phase.
> **This file is the answer to "where were we?"** Update it in the same
> commit as the work it describes.

**Plan:** `docs/PRD-PHASES.md`
**Baseline commit:** `d68fac7`
**Current phase:** Phase 1 — not started

---

## Status board

| Phase | Status | Owner | Notes |
| --- | --- | --- | --- |
| 1. Trust the library | ⬜ Not started | — | Paths + pagination |
| 1.1 `local_path` reconciliation | ⬜ | — | P0 |
| 1.2 Pagination | ⬜ | — | |
| 2. Telegram cold store | ⬜ Not started | — | |
| 2.1 Thumbnails | ⬜ | — | |
| 2.2 Integrity check | ⬜ | — | |
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

- [ ] Paths stored relative to `DATA_DIR`
- [ ] `file_state` column (`present | missing | recovering`)
- [ ] Startup reconciliation with summary log
- [ ] Refetch from Telegram on missing file
- [ ] Frontend shows "unavailable" state without breaking the timeline

_Log:_ (empty)

### 1.2 Pagination

- [ ] `GET /api/media?cursor=&limit=` returns `{items, next_cursor}`
- [ ] Cursor is `(capture_time, id)`
- [ ] Frontend appends instead of replacing
- [ ] Verified with a synthetic large library

_Log:_ (empty)

---

## Phase 2 — Telegram as a cold store

### 2.1 Thumbnails

- [ ] `data/thumbnails/` with `_thumb.webp` (400px) and `_micro.webp` (32px)
- [ ] `thumbnail_jobs` queue mirroring `upload_jobs`
- [ ] `GET /api/media/{id}/thumbnail` with immutable caching
- [ ] `preview_url` points at the thumbnail
- [ ] Video frame extraction via ffmpeg
- [ ] `POST /api/thumbnails/backfill`
- [ ] Verified: grid makes zero `/content` requests

_Log:_ (empty)

### 2.2 Integrity check

- [ ] `POST /api/integrity/check` verifies Telegram message existence
- [ ] Results write to `file_state`
- [ ] UI surfaces count; limitation documented in the UI itself

_Log:_ (empty)

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
