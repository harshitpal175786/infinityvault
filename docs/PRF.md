# PRF: InfinityVault — Product Requirements & Handoff

**Status:** Work in progress, paused
**Last updated:** 2026-02-14
**Repo:** `infinityvault` · branch `feat/infinityvault-setup`
**Purpose:** Resume-point document. Everything here is verified against the
code as it stands, not aspirational.

---

## 1. What InfinityVault is

A private, Google Photos-style timeline for photos and videos that backs up
**original files to the user's own Telegram Saved Messages**. The library
database (albums, tags, favourites, faces) is local; Telegram is the object
store.

```
Device gallery → React UI → FastAPI → SQLite metadata + job queue
                                  └→ Telethon → Telegram Saved Messages
```

## 2. Current state

### Working and verified

| Area | State |
| --- | --- |
| Upload + SHA-256 dedupe | Working |
| Telegram auth (phone, code, 2FA) | Working, encrypted session at rest |
| Background upload queue | Working, crash-safe (`reset_interrupted_jobs`) |
| Timeline, albums, tags, favourites, archive, trash | Working |
| Search (name, description, folder path) | Working, server-backed |
| Light + dark theme | Working, animated, persisted |
| Face detection + embedding + clustering | Backend complete, **no UI** |
| Smooth scroll / page transitions | Working |

### Services

```bash
npm run infinityvault -- start            # both services
npm run infinityvault -- setup            # first run + Telegram credentials
npm run infinityvault -- faces            # optional face-recognition deps
```

Frontend `http://127.0.0.1:5173/` · Backend `http://127.0.0.1:8000/`

Private config lives at `~/.config/infinityvault/.env` (mode 0600).

## 3. Codebase map

```
backend/app/
  main.py              542 lines  HTTP surface (all routes)
  db.py                886 lines  schema, migrations, all SQL
  telegram_service.py  287 lines  Telethon, upload worker, media cache
  face_service.py      279 lines  InsightFace, face worker, clustering

frontend/src/
  App.tsx              937 lines  ← the main remaining refactor target
  index.css           1710 lines  210 rules, tokens-only, 3 breakpoints
  styles/tokens.css    268 lines  design tokens, light + dark
  hooks/useTheme.ts     77 lines  theme + animated switch
  hooks/usePolling.ts   74 lines  single-timer poll, focus refresh
  components/ThemeToggle.tsx
  api.ts / media.ts / types.ts    transport, EXIF, view types

scripts/infinityvault.mjs   285 lines  launcher CLI
docs/
  prd-ui-immich-alignment.md    PRD + face-recognition appendix
  token-reconciliation.md       what real Immich changed in the PRD
  research/immich-synology-analysis.md
```

## 4. Design system (done)

Reconciled against real Immich source (`87ef895`), not guessed. See
`docs/token-reconciliation.md`.

| Token | Value | Source |
| --- | --- | --- |
| `--primary` | `#4250af` | Immich `--immich-primary` |
| dark `--bg` | `#0a0a0a` | `--immich-dark-bg` |
| dark `--surface` | `#212121` | `--immich-dark-gray` |
| dark `--on-surface` | `#e5e7eb` | `--immich-dark-fg` |
| font | Inter (OFL) | theirs is Google Sans, **not redistributable** |

Rules held: no literal colours in component CSS, no `Playfair`/purple left,
one `.media-grid` rule (`auto-fill`, 180px target) replacing three competing
declarations, three breakpoints (1279 / 1023 / 767) replacing eight
near-duplicate `@media` blocks.

**Immich is AGPL-3.0.** Behaviour and colour values were studied; no source
was copied. Their justified timeline needs per-asset ratios we don't reliably
have, so we use square tiles — tracked as a follow-up.

## 5. Face recognition (backend done)

`npm run infinityvault -- faces` installs `requirements-faces.txt` (~400 MB;
base install stays ~40 MB).

**Measured on M1 / 8 GB:** 20 ms per image steady-state, 512-D ArcFace
embeddings, CoreML acceleration detected. 10k photos ≈ 3.5 min.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/faces/status` | availability, model, job counts |
| POST | `/api/faces/scan` | queue unanalysed photos |
| POST | `/api/faces/cluster` | group faces into people |
| GET | `/api/people` | list with cover thumbnails |
| GET | `/api/people/{id}/media` | assets containing a person |
| PATCH | `/api/people/{id}` | rename |
| POST | `/api/people/merge` | merge two people |
| GET | `/api/faces/{id}/thumbnail` | 160px padded crop |

Greedy cosine clustering at `>= 0.5` (configurable via
`INFINITYVAULT_FACE_SIMILARITY`). Under-merging is preferred: splitting two
people is a UI fix, fusing two relatives silently corrupts the library.

Design constraints met: optional (app fully works without it), serial worker,
CPU-default, event loop never blocked. Missing deps raise `FaceUnavailable`,
park the worker, and mark the job failed with a reason — verified.

## 6. Known gaps, in priority order

### P0 — data bug, blocks other work

**`local_path` is stored absolute and breaks when the project moves.**
1 of 3 existing rows points at `/Users/harshit/Projects/telegram-gallery/...`
and cannot render (API correctly returns 404; UI shows "Preview unavailable").

This blocks face analysis for those rows and any real deployment. Needs a
startup reconciliation that detects missing files and re-fetches from Telegram.

### P1 — security

**`client_id` is the whole auth model.** It is read from a browser
localStorage value and trusted verbatim. `/api/media/{id}/content` falls back
to `"local-user"` when the header is absent, so any unauthenticated request
can read the default user's media by ID. Also means the library appears empty
in a new browser (each browser mints its own id — currently 3 ids in the DB
hold the 3 existing rows).

Minimum fix: a shared token in the env file, validated on every route.

### P2 — thumbnails

The grid serves **full-size originals** as previews (`FileResponse` on
`local_path`). A 7-column grid of 40 MB files is unusable at scale, and
`list_media` has **no LIMIT**. This got *more* visible when the grid got
denser. Immich solves it with a thumbnail pipeline; our research doc says the
same.

### P3 — `App.tsx` decomposition (PRD steps 3–6)

`App.tsx` is 937 lines. The PRD plans extracting `Sidebar`, `TopBar`,
`Timeline`, `MediaTile`, `SelectionBar`, `Viewer`, `Modal`, `Toast` into
`components/`, plus `useMediaLibrary` / `useSelection` hooks. Target: App.tsx
≈120 lines.

Steps 1–2 of the PRD (tokens, CSS consolidation) are **done**.

### P4 — People page UI

Endpoints exist; no interface. Needs a People grid (face circles + names),
rename inline, merge, and an "N photos" drill-down.

### P5 — smaller items

- `window.prompt()` used for album/tag creation (unstyled, blocking)
- Upload queue ignores `FloodWaitError`'s retry-after value
- Local upload files are never deleted after a successful Telegram backup
- `client_locks` / `media_locks` dicts grow unbounded
- Viewer has no thumbnail strip (deferred pending P2)

## 7. Verification harness

No test suite exists — a gap worth closing. What has been used so far:

```bash
cd frontend && npm run build                       # tsc --noEmit + vite build
cd backend  && .venv/bin/python -m compileall -q app
```

Behavioural checks were done with Playwright against a live server
(DOM measurement, theme persistence, drawer transform, upload state
transitions) and a throwaway SQLite file via `INFINITYVAULT_DB_PATH`.
Screenshots were read back with a vision model to catch layout faults.

Recommended next addition: pytest for the DB layer and `httpx` for routes —
both are cheap and cover the P0/P1 fixes.

## 8. Decisions taken, with rationale

| Decision | Why |
| --- | --- |
| Inter, not Google Sans | Google Sans is not redistributable |
| Square tiles, not justified | `width`/`height` unreliable in DB today |
| `buffalo_s`, not `buffalo_l` | 159 vs 326 MB; 2× faster; adequate for personal libraries |
| Serial face worker | 8 GB RAM; parallel workers swap |
| Cosine `>= 0.5` | Under-merge beats over-merge for family photos |
| Idle polling at 15 s | Backups finishing in another tab must land here |
| Removed fake `Explore`/`Sharing` nav | Placeholder navigation erodes trust |
| Dark mode follows OS by default | Photo library; respects user intent |

## 9. Constraints to keep in mind

- **InsightFace weights are non-commercial-research-only.** Fine for personal
  use. Shipping InfinityVault commercially requires different weights.
- **Immich is AGPL-3.0** — study, never copy.
- **Telegram limits**: 2 GB per upload (4 GB Premium). `api_id`/`api_hash` do
  not bypass size, rate, or account limits.
- **Target hardware**: runs on any machine via CPU. Tested on M1/8 GB.

## 10. Resume here

Recommended order:

1. **P0** `local_path` reconciliation — unblocks faces on old rows and any
   real deployment. Small and self-contained.
2. **P1** token auth — the one issue blocking exposure beyond localhost.
3. **P2** thumbnails + pagination — makes the denser grid viable.
4. **P4** People page UI — backend is ready and it is the visible payoff.
5. **P3** `App.tsx` decomposition — do it alongside P4 so new UI lands in
   components rather than the monolith.

Open questions still unanswered from PRD §11:

- Keep the gradient brand mark or flatten it?
- Is InfinityVault personal-only? (decides whether `buffalo_s` weights are
  acceptable at all)
- Viewer thumbnail strip now, or after P2?