# AI Context Handoff — InfinityVault

> **For an AI coding agent picking this up cold.**
> Read this file first, then **`docs/PRD-PHASES.md`** for the active plan and
> `docs/PHASE-LOG.md` for exactly how far along it is.
> `docs/PRF.md` is background/priorities; the phased PRD supersedes its §10.
> Everything below was verified against the code, not assumed.
> Last updated: 2026-02-14 · branch `feat/infinityvault-setup`

---

## 0. TL;DR

Private Google-Photos-style gallery that backs up **original files to the
user's own Telegram Saved Messages**. React 18 + Vite frontend, FastAPI +
SQLite backend, Telethon for Telegram, InsightFace for faces.

**Working:** upload, Telegram backup, albums/tags/trash, search, light+dark
theme, face detection + clustering (API only).
**Next task:** fix P0 `local_path` (see §7). It is small and unblocks others.

---

## 1. Environment

```bash
# macOS, Apple M1, 8 GB RAM (the reference machine)
# Python 3.13.8, Node 26.3.0

npm run infinityvault -- start       # both services
npm run infinityvault -- setup       # first run, prompts for Telegram creds
npm run infinityvault -- faces       # OPTIONAL face deps (~400 MB)
```

- Frontend `http://127.0.0.1:5173/` (Vite, hot reload)
- Backend `http://127.0.0.1:8000/` (uvicorn)
- Private config `~/.config/infinityvault/.env` (mode `0600`) — **never print
  its contents, never commit it.**
- Local data `backend/data/` (gitignored): `infinityvault.db`, `uploads/`,
  `telegram-cache/`, `session.key`

### Verification commands (there is no test suite yet)

```bash
cd frontend && npm run build                      # tsc --noEmit + vite build
cd backend  && .venv/bin/python -m compileall -q app
```

To boot against a throwaway DB without touching real data:

```bash
INFINITYVAULT_DB_PATH=/tmp/scratch.db backend/.venv/bin/python -m uvicorn app.main:app --port 8011
```

## 2. Repo layout

```
infinityvault/
  package.json                     launcher entry (`npm run infinityvault`)
  scripts/infinityvault.mjs        CLI: setup | start | faces | help
  backend/
    requirements.txt               core deps (5, ~40 MB)
    requirements-faces.txt         OPTIONAL face deps (~400 MB)
    app/
      main.py        542  all HTTP routes (29)
      db.py          886  schema, migrations, every SQL statement
      telegram_service.py 287  Telethon, upload worker, media cache
      face_service.py     279  InsightFace worker, clustering
  frontend/
    index.html                     inline theme guard (prevents FOUC)
    src/
      App.tsx        937  ← monolith, target of refactor P3
      index.css     1710  210 rules, tokens only, 3 breakpoints
      styles/tokens.css 268  design tokens (light + dark)
      hooks/useTheme.ts  77  theme + animated switch
      hooks/usePolling.ts 74  single-timer poll
      components/ThemeToggle.tsx
      api.ts / media.ts / types.ts
  docs/
    PRD-PHASES.md                  ← ACTIVE PLAN: phases 1-7, task by task
    PHASE-LOG.md                   ← living checklist: what is done, right now
    PRF.md                         ← background + priorities (superseded by PRD §10)
    prd-ui-immich-alignment.md     design PRD + face appendix
    token-reconciliation.md        Immich-derived token values
    research/immich-synology-analysis.md
```

---

## 3. Tech stack & deps (exact)

### Backend
```
fastapi==0.115.6
uvicorn[standard]==0.34.0
python-multipart==0.0.20
telethon==1.38.1
cryptography==44.0.0
# optional (requirements-faces.txt)
insightface>=0.7.3,<3
onnxruntime>=1.17
opencv-python-headless>=4.9
numpy>=1.24
```

### Frontend
```
react ^18.3.1, react-dom ^18.3.1
lucide-react ^0.468.0     (icons)
exifr ^7.1.3              (EXIF capture time, client-side)
dev: vite ^6, typescript ^5.7
```

**No UI component library. No ORM. No test framework.** Intentionally small.

---

## 4. Database schema (SQLite, raw `sqlite3`)

Tables: `media_items`, `upload_jobs`, `albums`, `album_media`, `tags`,
`media_tags`, `telegram_connections`, `people`, `faces`, `face_jobs`.

Key conventions:

- All DB access is in `db.py`. Routes never write SQL.
- Connections are opened per query via `open_db()`; `row_factory = sqlite3.Row`.
- Migrations are additive and idempotent: `PRAGMA table_info` +
  `ALTER TABLE ... ADD COLUMN`.
- IDs are UUID4 strings. Timestamps are ISO-8601 UTC strings.
- `media_items.local_path` is **absolute** — see P0 bug in §7.
- `faces.embedding` is a **float32 BLOB**, L2-normalised at write time, so
  similarity is a plain dot product.
- `upload_jobs` and `face_jobs` are separate queues with the same state
  machine: `queued → running/uploading → done/uploaded | failed`.
  Interrupted jobs are reset to `queued` on startup.

---

## 5. API surface (all 29 routes)

Client identity is the `X-Client-ID` header (default `local-user`).
**This is not real auth** — see §7 P1.

```
GET    /health, /api/health
GET    /api/telegram/status
POST   /api/telegram/auth/start        {phone_number}
POST   /api/telegram/auth/verify       {code, password?}
POST   /api/telegram/disconnect

GET    /api/media?view=&search=&album_id=
POST   /api/media                      multipart: file, captured_at, media_type, width, height, duration
PATCH  /api/media/{id}                 favorite, archived, trashed, description, captured_at, folder_path
DELETE /api/media/{id}
GET    /api/media/{id}/content          local preview (404 if file missing)
GET    /api/media/{id}/telegram-content    full original via Telegram
GET    /api/media/{id}/telegram-download   same, Content-Disposition: attachment
POST   /api/media/{id}/retry

GET    /api/albums, POST /api/albums, DELETE /api/albums/{id}
POST   /api/albums/{id}/media
GET    /api/tags,  POST /api/tags
POST   /api/tags/{id}/media

GET    /api/faces/status
POST   /api/faces/scan
POST   /api/faces/cluster
GET    /api/faces/{face_id}/thumbnail
GET    /api/people
GET    /api/people/{id}/media
PATCH  /api/people/{id}                {name}
POST   /api/people/merge               {source_id, target_id}
```

`view` ∈ `library | favorites | archive | trash | album`
(defined as `LibraryView` at `App.tsx:44` — not yet extracted to `types.ts`).

---

## 6. What is DONE vs NOT DONE

### ✅ Done and verified

| Feature | Notes |
| --- | --- |
| Upload with SHA-256 dedupe | Duplicate returns existing row, `duplicate: true` |
| Telegram auth (phone/code/2FA) | Fernet-encrypted StringSession at rest |
| Background upload queue | Serial worker, crash-safe, retries failed items |
| Timeline, albums, tags, favourites, archive, trash | Albums/tags reference media, never duplicate files |
| Search | Server-side over name + description + folder_path |
| Light + dark theme | Animated switch, persisted, respects `prefers-color-scheme`, no FOUC |
| Smooth scroll | `scroll-behavior`, view-change scroll-to-top |
| Realtime polling | `usePolling`: 2 s active / 15 s idle, focus refresh, no overlap |
| Mobile drawer | Sidebar reachable at 375 px (previously `display:none`) |
| Face detect + embed + cluster | **API only, no UI.** 20 ms/image on M1 |

### ❌ Not done

| Item | Where |
| --- | --- |
| People page UI | P4 |
| Thumbnails (grid serves full originals) | P2 |
| Pagination (`list_media` has no LIMIT) | P2 |
| Real auth (client_id is trusted) | P1 |
| `local_path` reconciliation | **P0 — do this first** |
| `App.tsx` decomposition | P3 |
| Tests | none exist |
| Video frames / full re-cluster | not started |

---

## 7. Open issues, ranked

### P0 — `local_path` is absolute and breaks on move  ← START HERE

1 of 3 existing rows points at
`/Users/harshit/Projects/telegram-gallery/backend/data/uploads/...` (old
folder name). File is gone; `/api/media/{id}/content` correctly returns 404
and the UI shows a "Preview unavailable" placeholder.

**Fix:** on startup, detect rows whose `local_path` is missing and either
re-resolve within `UPLOAD_DIR` by filename or re-download from Telegram via
`telegram_service.telegram_media_path()`. Log what was recovered.
This also unblocks face analysis for those rows.

### P1 — `client_id` is the entire auth model

Read from browser `localStorage`, trusted verbatim. `/api/media/{id}/content`
falls back to `"local-user"` when the header is absent (3 occurrences in
`main.py`), so an unauthenticated request can read the default user's media.

**Minimum fix:** shared token in the env file, validated on every route.
Also explains why a fresh browser shows an empty library (each browser mints
its own id — 3 different ids currently hold the 3 existing rows).

### P2 — no thumbnails, no pagination

`preview_url` serves the **full original** (`FileResponse`). `list_media` has
zero `LIMIT`. The 7-column grid will be unusable at scale.
Immich solves this with a thumbnail pipeline.

### P3 — `App.tsx` is 937 lines

PRD steps 3–6: extract `Sidebar`, `TopBar`, `Timeline`, `MediaTile`,
`SelectionBar`, `Viewer`, `Modal`, `Toast` into `components/`, plus
`useMediaLibrary` / `useSelection` hooks. Do this **alongside** P4 so new UI
lands in components.

### P4 — People page UI (backend ready)

Needs: face-circle grid with names, inline rename, merge, "N photos"
drill-down. All endpoints exist and were tested end-to-end.

### P5 — smaller

`window.prompt()` for album/tag creation (3 uses) · `FloodWaitError` retry
value ignored · local upload files never deleted after backup ·
`client_locks`/`media_locks` grow unbounded · viewer has no thumbnail strip.

---

## 8. Hard constraints — do not violate

1. **InsightFace pretrained weights are non-commercial-research-only.**
   Fine for personal use. A commercial release needs different weights. Do
   not present face features as commercially safe.
2. **Immich is AGPL-3.0.** Behaviour and colour values were studied; **no
   Immich source was copied.** Keep it that way.
3. **Google Sans is not redistributable.** We use Inter (OFL). Don't swap it
   back.
4. **Telegram limits:** 2 GB/upload (4 GB Premium). API credentials do not
   bypass size, rate, or account limits.
5. **Never print or commit** `~/.config/infinityvault/.env`, `session.key`,
   `backend/data/*`, or any `*.session`.

---

## 9. Design-system rules

Tokens live in `frontend/src/styles/tokens.css` (80 custom properties).
Anchors reconciled against real Immich at commit `87ef895`:

| Token | Light | Dark |
| --- | --- | --- |
| `--primary` | `#4250af` | `#accbfa` |
| `--bg` | `#f7f8fa` | `#0a0a0a` |
| `--surface` | `#ffffff` | `#161616` |
| `--on-surface` | `#1b1f27` | `#e5e7eb` |
| `--on-surface-variant` | `#6b7381` | `#9aa1ab` |
| `--outline` | `#dde1e8` | `#2e2e2e` |

**Rules when editing CSS:**

- **No literal colours in component CSS.** Only `var(--token)`.
- Theme applies via `data-theme="light|dark"` on `<html>`, plus
  `color-scheme` so native controls follow.
- Transition attribute `data-theme-transition` is added only during a switch
  and removed after 360 ms. The CSS transitions themselves run 320 ms (the
  extra 40 ms guards against the removal clipping the last frame). Never leave
  the attribute on, or the first paint animates.
- Every animation must respect `@media (prefers-reduced-motion: reduce)`.
- Grid is one rule: `repeat(auto-fill, minmax(var(--tile-target), 1fr))`
  with `--tile-target: 180px` and `--gap-media: 2px`.
- Breakpoints are exactly three: **1279 / 1023 / 767**. Don't add more.

---

## 10. Code conventions observed

- Backend: type hints everywhere, `from __future__ import annotations` in new
  modules, routes are thin and delegate to `db.*`, errors raise
  `HTTPException` with human-readable `detail`.
- Blocking work (inference, SQL from async code) goes through
  `asyncio.to_thread` / a single-thread `Executor`. **Never block the event
  loop.**
- Workers are serial by design (8 GB RAM). Do not add parallelism without
  reconsidering memory.
- Frontend: function components, hooks, no state library. Optimistic updates
  with server reconciliation.
- Comments explain **why**, not what. Several existing comments document a
  bug that was fixed — keep them.

---

## 11. Suggested first actions for a new agent

1. Read `docs/PRD-PHASES.md` §1 (the architectural rule) and §3 (definition of done).
2. Check `docs/PHASE-LOG.md` — it states the current phase and the next unticked task.
3. Run the two verification commands in §1 to confirm a clean baseline.
4. Implement the next unticked task, starting at Phase 1.1
   (`local_path` reconciliation) if nothing is marked in progress.
5. Update `docs/PHASE-LOG.md` in the same commit as the work.
5. Ask the user the outstanding product questions before building UI:
   - Is InfinityVault personal-only, or might it be released? (decides whether
     `buffalo_s` weights are acceptable)
   - Keep the gradient brand mark or flatten it?
   - Viewer thumbnail strip now, or after thumbnails exist (P2)?

---

## 12. Known-good behaviours (regression checklist)

After any change, confirm:

- [ ] Upload → status reaches `backed up` (or `waiting_for_telegram` if not connected)
- [ ] Duplicate upload returns the existing item, `duplicate: true`
- [ ] Search hits the network (`?search=` appears in the request)
- [ ] Idle library still polls (≈15 s) and picks up external changes
- [ ] Theme toggle persists across reload with no flash
- [ ] At 375 px width, Albums/Archive/Trash are reachable via the drawer
- [ ] `/api/media/{id}/content` returns 404 (not 500) for a missing file
- [ ] App boots with face deps **absent** — `/api/faces/status` reports
      `available: false` and nothing else breaks
