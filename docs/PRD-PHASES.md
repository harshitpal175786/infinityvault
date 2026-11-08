# PRD: InfinityVault — Phased Plan (Telegram-as-Storage)

**Version:** 1.0 · **Date:** 2026-02-14
**Status:** Ready for implementation
**Supersedes:** the undated roadmap in `docs/PRF.md` §10
**Baseline commit:** `d68fac7`

---

## 0. Purpose of this document

This is a **context-loss-proof plan**. If every conversation is forgotten, a
new engineer or AI can open this file alone, pick any phase, and know exactly
what to build, what "done" means, and what it must not break.

Read in this order: §1 → §2 → §3 → §4 (the phase you own) → §7.

---

## 1. The one architectural decision

> **Do all expensive work once, at upload time, and cache it locally.
> Telegram is the cold store and must never appear in a user-facing read path.**

This single rule resolves the "can we have Immich features on Telegram
storage?" question. It is the whole design.

### Consequences

| Rule | Consequence |
| --- | --- |
| Reads never call Telegram | Grid and viewer serve cached local files |
| Expensive work is one-time | Thumbnails generated at upload, not per request |
| Cache is disposable | Deleting `telegram-cache/` degrades gracefully, never corrupts |
| Originals are authoritative | If a cache entry is lost, refetch from Telegram |
| Metadata stays in SQLite | No Postgres dependency |

### Why not Postgres + Redis + BullMQ

Measured on the reference machine (M1, 8 GB):

| Component | RAM |
| --- | --- |
| Backend idle today | 6 MB |
| Face model loaded | 544 MB |
| Free RAM at time of measurement | 1,341 MB |
| Postgres + Redis + worker (est.) | ~400 MB |

Adding that stack consumes the remaining headroom before lock-screen caching
or video work is even considered. The **only** capability Postgres buys is an
HNSW vector index, needed past ~100k faces. Immich uses `vector(512)`; so do
we. A linear scan over SQLite BLOBs is sufficient at personal scale.

**Decision:** stay on SQLite. Revisit only if the library exceeds ~100k assets
or a second user is ever added.

---

## 2. Constraints that shape every phase

1. **8 GB RAM.** Job workers are serial. Never run two model-bearing jobs at once.
2. **Telegram limits.** 2 GB/upload (4 GB Premium). Rate limits apply; honour `FloodWaitError.seconds`.
3. **One process.** No worker clustering.
4. **Immich is AGPL-3.0.** Study behaviour and values; never copy source.
5. **InsightFace weights are non-commercial-research-only.**
6. **Google Sans is not redistributable.** Inter stays.
7. **Optional features must not break the base install.** Missing deps →
   report capability as false, never crash.
8. **Never commit** `~/.config/infinityvault/.env`, `*.session`, `backend/data/`.

---

## 3. Definition of done (applies to every task)

A task is done only when **all** apply:

- [ ] Code compiles: `cd backend && .venv/bin/python -m compileall -q app`
- [ ] Frontend builds: `cd frontend && npm run build`
- [ ] The specific behaviour was **exercised against a live server**, not just reasoned about
- [ ] Degradation path tested (missing file, missing dep, or empty library)
- [ ] No regression in `docs/AI-CONTEXT.md` §12 checklist
- [ ] Schema changes are additive and idempotent (never destructive)
- [ ] Documented in this file's phase log (§9)

"Compiles" is not done. "I ran it and saw the result" is done.

---

## Phase 1 — Trust the library (data integrity)

**Goal:** every row in the DB points at a file we can actually read, and the
database can be trusted after a move or a crash.
**Why first:** every later phase (thumbnails, faces, transcoding) assumes
`local_path` is valid. Building on broken paths multiplies the bug.
**Effort:** S · **Risk:** low · **Touches:** `db.py`, `main.py`

### 1.1 `local_path` reconciliation on startup

**Problem (verified):** 1 of 3 existing rows points at
`/Users/harshit/Projects/telegram-gallery/backend/data/uploads/...` — the old
folder name. The file is gone; `/api/media/{id}/content` returns 404.

**Root cause:** absolute path stored in the row. Moving the project or
renaming a folder invalidates it.

**Fix:**
1. Store paths **relative to `DATA_DIR`** going forward.
2. Add `ensure_local_file(media_id)` in `db.py` / `telegram_service.py`:
   - If `local_path` is absolute and outside `DATA_DIR`, rebase onto
     `UPLOAD_DIR` by filename.
   - If the file is missing, attempt refetch from Telegram; if that fails,
     mark the row `file_missing` and keep serving metadata.
3. Run reconciliation in `lifespan` startup; log a summary line
   (`recovered N, missing M`).
4. Add a `file_state` column: `present | missing | recovering`.

**Done when:** starting the server with a deliberately moved file logs the
recovery, and the row renders again. A permanently-missing file returns 404
with a clear detail and does not break the timeline.

### 1.2 Pagination

**Problem (verified):** `list_media` has **no `LIMIT`**. The whole library
loads on every poll (every 2 s while active).

**Fix:** `GET /api/media?cursor=&limit=200` returning `{items, next_cursor}`.
Cursor = `(capture_time, id)` for stable ordering. Frontend: `usePolling`
becomes incremental; the grid appends rather than replaces.

**Done when:** a 5,000-row synthetic library loads in pages, scroll position
survives polling, and the network tab shows `limit=200`.

---

## Phase 2 — Telegram as a cold store (thumbnails)

**Goal:** the UI never serves a full-size original as a preview.
**Why second:** after Phase 1 the paths are trustworthy, so a cache keyed on
them is safe. This is the single biggest UX win.
**Effort:** M · **Risk:** medium · **Touches:** new `thumbnail_service.py`, `main.py`, `db.py`

### 2.1 Thumbnail generation

**Problem (verified):** `preview_url` → `/api/media/{id}/content` →
`FileResponse(local_path)`. A 40 MB photo is downloaded to show a 180px tile.

**Design:**
- On upload completion, generate **two** derivatives into
  `data/thumbnails/` (new dir, separate from `telegram-cache/`):
  - `{id}_thumb.webp` — 400px longest edge, quality 80
  - `{id}_micro.webp` — 32px blurred placeholder (for progressive load)
- Use **Pillow** (already needed) — adds ~3 MB, cross-platform, no native build.
- Generation is a **job**, not inline: add `thumbnail_jobs` mirroring
  `upload_jobs`/`face_jobs` state machine.
- Videos: extract frame at 1 s via the existing ffmpeg, then thumbnail that.

**New endpoint:** `GET /api/media/{id}/thumbnail` → cached webp,
`Cache-Control: private, max-age=31536000, immutable`.
`preview_url` switches to this. `content` stays for download.

**Backfill:** `POST /api/thumbnails/backfill` queues every row lacking one.

**Done when:** the grid loads a 200-photo library with zero requests to
`/content`, total transfer under a few MB, and the viewer still opens the
full original on demand.

### 2.2 Integrity check

**Problem:** a Telegram message can be deleted out-of-band; we would not know.

**Fix:** `POST /api/integrity/check` verifies, per row, that the Telegram
message id still exists (a metadata call, not a download). Results into
`file_state`. UI surfaces a small "N items need attention" in Utilities.

**Honest limit:** this proves *existence*, not byte-perfect equality. A full
checksum would require downloading every original. State that in the UI.

**Done when:** deleting a test message out-of-band causes the item to be
flagged, and the UI offers "re-upload from local copy" when one exists.

---

## Phase 3 — Identity (auth)

**Goal:** the library is not readable by anything that knows a URL.
**Why here:** Phases 1–2 make the app *useful*; Phase 3 makes it *safe* to
expose beyond localhost. Do not deploy before this.
**Effort:** M · **Risk:** medium (can lock the user out) · **Touches:** `main.py`, `db.py`, frontend `api.ts`

### 3.1 Token auth

**Problem (verified):** `client_id` comes from browser `localStorage` and is
trusted verbatim. Three routes fall back to `"local-user"` when the header is
absent, so an unauthenticated request can read the default user's media.

**Fix:**
1. Generate a 32-byte token on first run; store in `~/.config/infinityvault/.env`
   (mode 0600). Print it to the console once during `setup`.
2. Require `Authorization: Bearer <token>` on **every** `/api/*` route except
   `/api/health`.
3. Remove all `"local-user"` fallbacks. Missing header → 401.
4. Frontend: token entry screen on 401, stored in `localStorage`, sent by `api.ts`.
5. Compare with `hmac.compare_digest` to avoid timing leaks.

**Done when:** curling `/api/media` without a token returns 401, with the
token returns 200, and the browser prompts once and remembers.

### 3.2 Single-user cleanup

`client_id` becomes a server-side constant, not a request input. Existing rows
keep their ids; a one-time migration maps all non-default ids to the owner.

---

## Phase 4 — Faces & People UI

**Goal:** the finished face backend becomes a visible feature.
**Why here:** needs Phase 1 (valid paths) to work on old rows.
**Effort:** M · **Risk:** low · **Touches:** new `People.tsx`, `PersonDetail.tsx`

### 4.1 People grid
Circle avatars from `/api/faces/{id}/thumbnail`, name or "Add name",
"N photos" count. Sorted by face count.

### 4.2 Person detail
Grid of that person's assets; inline rename; merge into another person with
a confirmation showing both counts.

### 4.3 Scan controls
People page header: "Scan library" when unanalysed photos exist, with live
progress from `/api/faces/status`. Hide entirely when `available: false`,
showing an install hint instead.

**Done when:** a fresh library scans, clusters into people, and each person's
detail shows the correct assets.

---

## Phase 5 — Browse & discover

**Goal:** reach the breadth of Immich's user-facing features that fit here.
**Effort:** M · **Risk:** low · **Touches:** several new pages

| Task | Notes |
| --- | --- |
| 5.1 Explore | Sections by city, tag, person, "recently added" |
| 5.2 Map / Places | Use existing `latitude`/`longitude` columns; no external tile server required — a simple clustered map or a place list first |
| 5.3 Memories | "On this day" across past years; cheap, high value |
| 5.4 Recently added | Trivial after Phase 1.2 pagination |
| 5.5 Duplicate finder | Group by existing SHA-256 `checksum`; review + delete UI |
| 5.6 Search filters | Date range, person, tag, place, favourites |
| 5.7 Utilities | Large files, missing files, geolocation gaps |

**Done when:** each page has an empty state, a loading state, and is reachable
from the sidebar without dead links.

---

## Phase 6 — Video (only if still needed)

**Goal:** playable video without re-downloading originals.
**Effort:** L · **Risk:** high · **Do last**

- Transcode to a 480p proxy **once**, keep it locally forever in
  `data/proxies/`. Original stays in Telegram.
- ffmpeg at `/opt/homebrew/bin/ffmpeg` (9.0.2 verified present).
- Serial job, lowest priority. Never run alongside face analysis.
- **Skip HLS** unless seeking proves essential; plain MP4 range requests are
  simpler and adequate.

**Done when:** a 100 MB phone video plays with sub-second start, and deleting
the proxy regenerates it on next play instead of failing.

---

## Phase 7 — Finish the UI refactor

**Goal:** `App.tsx` (937 lines) becomes ~120 lines.
**Why last:** every phase above adds UI. Do it once they exist, or repeat it.

- Extract `Sidebar`, `TopBar`, `Timeline`, `MediaTile`, `SelectionBar`,
  `Viewer`, `Modal`, `Toast` into `components/`
- Extract `useMediaLibrary`, `useSelection` hooks
- Keep tokens-only CSS; no literal colours

---

## 4. Dependency graph

```
Phase 1 (paths + pagination)
   ├── Phase 2 (thumbnails)  ← needs valid paths
   │      └── Phase 3 (auth) ← deploy gate
   ├── Phase 4 (people UI)   ← needs valid paths for old rows
   └── Phase 5 (browse)      ← needs pagination
            └── Phase 6 (video, optional)
                     └── Phase 7 (refactor, after UI settles)
```

Phase 3 does not depend on 2 and may run in parallel.

---

## 5. Out of scope (decided, not forgotten)

| Excluded | Reason |
| --- | --- |
| Multi-user, admin console, RBAC | Contradicts private single-user design |
| OAuth / OIDC / passkeys | No account system, by design |
| Postgres + Redis + BullMQ | Measured RAM cost; only gains an index we don't need yet |
| pgvector/HNSW | Linear scan fine below ~100k faces |
| CLIP smart search | +600 MB model on an 8 GB machine |
| OCR | Model + per-image cost, low value here |
| Storage templates | No user-visible file tree |
| External libraries | Nothing local to import from |
| Library filesystem walk | Telegram is the only store |
| Mobile app (Flutter) | Separate product |
| Real-time collaborative sharing | Single user |

---

## 6. Risk register

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Thumbnail backfill too slow on big libraries | Medium | Serial job + progress endpoint; UI stays usable via placeholders |
| Telegram FloodWait during backfill | Medium | Honour `.seconds`; exponential backoff |
| Auth locks the user out | Medium | Token also written to the env file and printed at setup |
| Pillow wheel missing on some platform | Low | Pure-availability check; degrade to no thumbnails with a banner |
| Proxy cache fills the disk | Medium | Report total size in Utilities; never auto-delete originals |
| Face model + thumbnail job overlap on 8 GB | Medium | Shared serial job lock; one heavy job at a time |
| Phase 7 churn | High if done early | Explicitly sequenced last |

---

## 7. How to resume after context loss

1. Read §1 (the rule) and §3 (definition of done).
2. Check `docs/PHASE-LOG.md` for the last completed task.
3. Run the two verification commands in §3 to confirm a clean baseline.
4. Pick the next unchecked task in the earliest incomplete phase.
5. Do not start a phase whose predecessor is incomplete.

---

## 8. Success criteria for the whole plan

- Library loads with cached thumbnails; `/content` is never in a grid request
- Any row whose file vanished is reported, not silently broken
- Unauthenticated requests are refused on every data route
- People page works end-to-end on a scanned library
- Search filters by date, person, tag, place
- Base install stays under ~50 MB; faces stay optional
- App still starts with one command on macOS, Windows, Linux
