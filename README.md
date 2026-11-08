# InfinityVault

A private, self-hosted photo and video library that backs up your **originals**
to your own **Telegram Saved Messages** and browses them like Google Photos —
timeline, albums, tags, faces, maps and all.

No cloud account. No subscription. Your photos live in a chat you already own,
and the metadata lives in a SQLite file on your machine.

```
Your device ──▶ InfinityVault (localhost) ──▶ Telegram Saved Messages
                      │
                      └── SQLite: albums, tags, faces, places, settings
```

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Install](#install)
- [Usage guide](#usage-guide)
- [Disaster recovery](#disaster-recovery)
- [Configuration](#configuration)
- [Data on disk](#data-on-disk)
- [API reference](#api-reference)
- [Security model](#security-model)
- [Performance notes](#performance-notes)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Why this exists

Google Photos gives you a timeline, face grouping and a map — and keeps your
originals in a datacentre you don't control. Telegram gives you unlimited file
storage in a chat you already own, but no photo library interface.

InfinityVault is the middle: **Telegram holds the bytes, InfinityVault holds the
organisation.** Albums, tags, faces, favourites and places are all local and
recoverable; the media itself never depends on this app surviving.

---

## Features

### Library
- Timeline grouped by capture date, newest or oldest first
- Cursor-based pagination that survives new uploads arriving mid-scroll
- Favourites, Archive, Trash with restore and permanent delete
- Albums with multi-album membership; tags with batch application
- Editable capture time, folder path and description
- Full-text search across filename, description and folder path

### Photos and video
- EXIF capture time, GPS, camera make/model and lens read on import
- Thumbnails: a 400 px WebP for the grid, a 32 px blurred one for instant paint
- **Video proxies**: a 720p H.264 copy per video so playback starts immediately
  and the scrub bar works, instead of waiting for a full Telegram download
- Range requests (`206 Partial Content`) for seeking

### Discover
- **Explore**: Memories ("on this day"), Places map, Recently added, Tags,
  People, Areas, Duplicates
- Cookie-free local map — pins are clustered into labelled bubbles, and **no
  tile server is contacted**, so your photo locations never leave the machine
- Filters: date range, media type, has-faces, specific person, tag, place,
  favourites, has-location, camera, sort order

### Faces
- Offline face detection and 512-D embeddings (InsightFace `buffalo_s`)
- Automatic grouping into people, with rename and merge
- Runs on CPU, one job at a time, and is entirely optional

### Reliability
- Telegram integrity check: verifies each backed-up file still exists
- **Metadata backup to Telegram** — albums, tags, favourites and descriptions
  round-trip through Saved Messages, so a total reinstall can be rebuilt
- Automatic backup every 25 library changes
- SHA-256 duplicate detection before creating a second Telegram copy
- Startup reconciliation of local files that have moved or vanished

---

## Architecture

### Process layout

```
┌──────────────────────────────┐        ┌──────────────────────────┐
│  React + Vite (port 5173)    │  HTTP  │  FastAPI (port 8000)     │
│  ─────────────────────────   │ ─────▶ │  ─────────────────────   │
│  App.tsx  — timeline, upload │        │  main.py    57 routes    │
│  components/ People, Explore │        │  auth.py    bearer token │
│  hooks/   filters, theme     │        │  db.py      all SQL      │
└──────────────────────────────┘        └───────────┬──────────────┘
                                                    │
              ┌─────────────────────────────────────┼──────────────────┐
              ▼                    ▼                ▼                  ▼
     telegram_service.py   thumbnail_service   face_service      proxy_service
      Telethon client       WebP + blur-up     InsightFace        ffmpeg 720p
      upload/download       serial worker      serial worker      serial worker
              │
              ▼
     Telegram Saved Messages
```

### Serial workers — why

Three background workers exist, and **none of them run concurrently on the same
asset**:

| Worker | Does | Why serial |
|---|---|---|
| `thumbnail_service` | 400 px + 32 px WebP | Fast; queue never grows |
| `face_service` | Detect + embed faces | Loads a ~544 MB model |
| `proxy_service` | 720p H.264 re-encode | Saturates a CPU core |

Proxies run in their **own** worker so a queue of large videos can never delay
the thumbnail of a photo you just uploaded. This is a deliberate trade against
throughput: on an 8 GB Apple M1 the face model plus Postgres, Redis and a job
queue would swap, so the whole design stays SQLite + in-process workers.

### Backend modules

| File | Lines | Responsibility |
|---|---|---|
| `main.py` | 1357 | All 57 HTTP routes, request/response shapes |
| `db.py` | 2272 | Schema, migrations, every query |
| `telegram_service.py` | 519 | Telethon session, upload queue, download cache |
| `face_service.py` | 279 | InsightFace load, detect, embed, cluster |
| `proxy_service.py` | 187 | ffmpeg command construction, proxy worker |
| `thumbnail_service.py` | 171 | WebP generation, video frame extraction |
| `auth.py` | 128 | Token load/validate, header or query extraction |

### Frontend modules

| File | Lines | Responsibility |
|---|---|---|
| `App.tsx` | 879 | Timeline, upload, selection, topbar |
| `components/ExplorePage.tsx` | 388 | Memories, Places, Tags, People, Areas, Duplicates |
| `components/UtilitiesPage.tsx` | 370 | Integrity, backup, restore, videos, storage |
| `components/MediaViews.tsx` | 366 | Card, viewer, metadata modal, Telegram modal |
| `components/PeoplePage.tsx` | 335 | People grid, rename, merge |
| `components/Sidebar.tsx` | 140 | Navigation, quick filters, storage status |
| `api.ts` | 513 | Typed client, token handling, URL building |
| `hooks/useLibraryFilters.ts` | 120 | View, tab, sort and filter state |

### Database schema

```
media_items     one row per asset: path, capture_time, checksum, size,
                dimensions, lat/lon, camera fields, upload_status,
                file_state, thumb_state, proxy_state, integrity_state
upload_jobs     per-asset Telegram upload state and retry counters
thumbnail_jobs  WebP generation queue
face_jobs       detection queue
albums          album metadata
album_media     media ↔ album membership
tags            tag names
media_tags      media ↔ tag membership
people          clustered identities (name, cover_face_id, face_count)
faces           one row per detected face: bbox, det_score, 512-D embedding BLOB
telegram_connections  encrypted Telethon session per client
app_settings    key/value, including the auto-backup change counter
```

Every schema change is **additive and idempotent** — a `migrations` dict in
`db.py` adds missing columns on boot and never drops or rewrites.

### API reference

All routes are under `/api`. Authentication is a bearer token (see
[Security model](#security-model)).

| Group | Routes |
|---|---|
| `media` | list/filter/paginate, get, patch, delete, retry, thumbnail, micro-thumbnail, content, telegram-content, telegram-download, proxy |
| `albums` / `tags` | CRUD + membership |
| `telegram` | status, connect, verify, disconnect |
| `auth` | status |
| `faces` / `people` | status, scan, people list, rename, merge, face thumbnail |
| `geo` / `explore` | points, backfill, places, tags, people, memories, recently-added, duplicates, duplicates/resolve |
| `cameras` | list, backfill |
| `videos` | status, proxies |
| `integrity` | status, check, broken |
| `backup` / `restore` | metadata backup, status, scan, apply |
| `utilities` | large-files, location-gaps |
| `thumbnails` | status, enqueue |
| `health` | liveness |

Two rules that are easy to get wrong:

1. **Any endpoint whose URL is loaded into `<img>` or `<video>` must accept
   `?client_id=` and `?access_token=`**, because the browser cannot attach
   headers to those requests.
2. Everything else may rely on headers.

---

## Requirements

| | |
|---|---|
| Node.js | 18+ |
| Python | 3.11+ |
| Telegram | `api_id` + `api_hash` from [my.telegram.org](https://my.telegram.org) |
| ffmpeg | Required for video thumbnails and proxies. `brew install ffmpeg` |
| Disk | Thumbnails ~25 KB/photo; proxies 1-4 MB/minute of video (measured 1.1-3.2 on synthetic footage; real video sits higher) |

Telegram limits single uploads to 2 GB (free) or 4 GB (Premium). These API
credentials do not bypass Telegram's size, rate or account limits.

---

## Install

### One command

```bash
npm run infinityvault -- setup
```

This will:

1. Ask for your Telegram `api_id` and `api_hash` (hash hidden while typing)
2. Save them to `~/.config/infinityvault/.env` with `0600` permissions — **outside
   the repository**, so they can never be committed
3. Create `backend/.venv` and install Python + Node dependencies
4. Start the backend and frontend together

Open **http://127.0.0.1:5173/**.

You should see:

```
Frontend: http://127.0.0.1:5173/
Backend:  http://127.0.0.1:8000/
Press Ctrl+C to stop both services.
```

The command stays in the foreground while the services run. That is expected —
don't wait for it to return.

### Restarting later

```bash
npm run infinityvault -- start              # checks + installs if needed
npm run infinityvault -- start --no-install # skip dependency checks
```

### Optional: face recognition

```bash
npm run infinityvault -- faces
```

Adds `insightface`, `onnxruntime`, `opencv-python-headless` and `numpy`
(~400 MB, plus a 159 MB model on first run). Kept out of the base install so the
default stays ~40 MB. The app runs fine without it — face features simply report
as unavailable.

### Optional: access token

```bash
npm run infinityvault -- token
```

Generates a 256-bit token, stores it as `INFINITYVAULT_ACCESS_TOKEN` (mode
`0600`, preserving existing `TELEGRAM_*` values), and prints it once. Restart,
then paste it into the browser prompt. Run again to rotate.

---

## Usage guide

### First run

1. **Connect Telegram** — click *Connect Telegram*, enter your phone number,
   the code from Telegram, and your 2FA password if set. The session is
   encrypted on disk and never sent to the browser.
2. **Add media** — drag files onto the window or click *Add photos & videos*.
   Files upload in the background; the tile shows *Queued → Uploading →
   Backed up*.
3. **Browse** — the timeline groups by capture date. Click any tile for the
   full viewer.

### Organising

- **Favourite / Archive / Trash** — hover a tile, or use the buttons in the
  viewer. Trash is recoverable; permanent delete lives in the Trash view.
- **Albums** — *Albums → +* in the sidebar, then select tiles and add them.
- **Tags** — same selection flow. Tags appear in Explore and in the filter bar.
- **Edit details** — open a tile → *Edit* to change capture time, folder path or
  description.

### Filtering

Click the filter icon in the toolbar. Available filters:

| Filter | Notes |
|---|---|
| From / To | Inclusive; To covers the whole day |
| Type | Photo or video |
| People | Has faces / no faces |
| Person | A specific named person |
| Tag | A specific tag |
| Place | Matches folder path and caption text |
| Favourites | Favourites only / not favourited |
| Location | Has GPS / no GPS |
| Camera | Built from cameras actually in your library |
| Order | Newest or oldest first |

**Why "Place" is text, not a city:** turning coordinates into a city name means
sending every photo's location to a third party. That was rejected, so Place
matches what you typed. Explore's *Areas* section shows coordinate buckets for
the same reason.

### People

*People* in the sidebar. Face detection runs automatically on new photos once
face support is installed.

- Click **Scan library** to process existing photos
- Click a name to rename; **Merge** to combine two people
- The grid is sorted by face count

Similarity threshold is cosine `0.5`, tuned to under-merge rather than
over-merge — a wrong "same person" is worse than two entries for one face.

### Video

Videos play from a 720p proxy that starts in about a second and scrubs
properly. The header shows **Playing preview**; click it to switch to
**Playing original** (full quality, but downloads the whole file first). If a
proxy fails, playback falls back to the original automatically.

*Utilities → Video previews → Build missing previews* backfills older videos.

### Utilities

| Section | What it tells you |
|---|---|
| Largest files | Where your space goes (read-only) |
| Photos without a location | GPS coverage, reported never guessed |
| Video previews | How many proxies are ready |
| Library integrity | Whether each original still exists in Telegram |
| Metadata backup | When the last snapshot was taken, and how many changes are pending |
| Restore | Scan Saved Messages and rebuild the library |

---

## Disaster recovery

Telegram is the archival store; this app is the organisation layer. Two
mechanisms protect the organisation.

### Metadata backup

`Utilities → Metadata backup` uploads a JSON snapshot to Saved Messages
containing albums, tags, memberships, favourites, descriptions and capture times.

It also runs **automatically** once 25 changes have accumulated, throttled by
*change count* rather than upload count — so a 500-photo import triggers one
snapshot, not 500.

### Restore after a total reinstall

1. Install and connect the same Telegram account
2. `Utilities → Restore → Scan Saved Messages`
3. Review what was found, then **Apply**

Restore is idempotent (keyed on `telegram_message_id`), so re-running it changes
nothing. Verified end to end: 3 media, 1 album, 1 tag, a favourite and a
description all survived deleting the database entirely.

**Limitation, stated plainly:** a caption scan alone recovers *photos* — it
cannot recover album or tag membership. That is why the JSON backup exists. Both
halves are needed; the UI says so.

---

## Configuration

Stored in `~/.config/infinityvault/.env` (mode `0600`), never in the repo.

| Variable | Default | Meaning |
|---|---|---|
| `TELEGRAM_API_ID` | — | From my.telegram.org |
| `TELEGRAM_API_HASH` | — | From my.telegram.org |
| `INFINITYVAULT_ACCESS_TOKEN` | unset | Bearer token. Unset means auth is off |
| `INFINITYVAULT_CONFIG` | `~/.config/infinityvault/.env` | Config path override |
| `INFINITYVAULT_ENV_FILE` | same | Env file override |
| `INFINITYVAULT_DB_PATH` | `backend/data/infinityvault.db` | Database path |
| `INFINITYVAULT_FACE_MODEL` | `buffalo_s` | `buffalo_l` is 326 MB, ~2× slower |
| `INFINITYVAULT_FACE_PROVIDER` | `auto` | `cpu`, `coreml`, `cuda` |
| `INFINITYVAULT_FACE_SIMILARITY` | `0.5` | Cosine threshold for same-person |
| `INFINITYVAULT_FACE_MIN_PIXELS` | `36` | Ignore faces smaller than this |

---

## Data on disk

```
backend/data/
  infinityvault.db      SQLite: all metadata, jobs, faces, settings
  uploads/              local originals awaiting/after backup
  thumbnails/           400px + 32px WebP per asset
  video-proxies/        720p H.264 per video
  telegram-cache/       downloaded originals (safe to delete)
  session.key           encryption key for Telegram sessions
```

`backend/data/` and the env file are git-ignored. **Back up `session.key`** if
you want to avoid re-authenticating Telegram.

Deleting `thumbnails/`, `video-proxies/` or `telegram-cache/` is safe — all are
derived and regenerate. Deleting `infinityvault.db` is recoverable only through
the metadata backup described above.

---

## Security model

- **Single owner.** This is one library, one person. The token proves *you are
  the owner*; there are no user accounts or sharing.
- Telegram sessions are encrypted at rest and never reach the browser.
- Credentials, keys, database, uploads and caches are all git-ignored.
- The token travels as a bearer header, or `?access_token=` for `<img>`/`<video>`
  requests that cannot set headers.

**The `?access_token=` tradeoff, stated honestly:** tokens in URLs can land in
browser history and server logs. It is unavoidable for media elements. Acceptable
on localhost; if you expose this beyond your machine, put it behind a reverse
proxy with signed URLs and TLS.

**Nothing here is safe to expose to the internet as-is.** No rate limiting, no
CSRF tokens, no TLS.

---

## Performance notes

Measured on an Apple M1 with 8 GB RAM:

| | |
|---|---|
| Backend idle | ~6 MB |
| Face model loaded | ~544 MB |
| Free RAM observed | ~1,341 MB |

This is why the stack is SQLite + in-process workers rather than
Postgres + Redis + BullMQ: that combination (~400 MB) plus the face model would
swap. Face analysis and proxy encoding never run at the same time.

---

## Development

```bash
# Backend
cd backend
.venv/bin/python -m uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
VITE_API_URL=http://127.0.0.1:8000 npx vite --port 5173
```

### Checks

```bash
cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build
cd backend && .venv/bin/python -m compileall -q app
```

### Testing against a throwaway library

```bash
INFINITYVAULT_DB_PATH=/tmp/test.db \
INFINITYVAULT_ENV_FILE=/tmp/empty.env \
.venv/bin/python -m uvicorn app.main:app --port 8099
```

The CORS allowlist is `localhost`/`127.0.0.1` on ports **5173** and **5180**
only. Use 5180 for a second Vite instance.

### Conventions

- **Tokens-only CSS** — no literal colours; everything comes from
  `styles/tokens.css`
- Exactly three breakpoints: **1279 / 1023 / 767**
- Honour `prefers-reduced-motion` for every animation
- Files written in parts, ≤300 lines per write

### Documentation map

| File | Purpose |
|---|---|
| `docs/PRD-PHASES.md` | The plan and its phases |
| `docs/PHASE-LOG.md` | What each phase actually did |
| `docs/PRD-COMPLIANCE-AUDIT.md` | PRD vs code, including deviations |
| `docs/AI-CONTEXT.md` | Orientation for a fresh session |
| `docs/immich-parity-analysis.md` | Feature comparison with Immich |

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Command shows URLs and doesn't return | Correct — it runs the services. Open `http://127.0.0.1:5173/` |
| `Port 5173/8000 already in use` | Another process holds it. `Ctrl+C` the old one |
| `Telegram credentials are missing` | Run `npm run infinityvault -- setup` |
| Videos won't play | Check ffmpeg: `which ffmpeg`. Then rebuild proxies in Utilities |
| No video thumbnail | Same — ffmpeg extracts the frame |
| People page says unavailable | Face deps not installed: `npm run infinityvault -- faces` |
| Photos have no location | EXIF has no GPS, or run *Explore → Find locations in existing photos* |
| Photos have no camera | Run *Explore → Find cameras in existing photos* |
| Browser keeps asking for a token | Token rotated. Run `npm run infinityvault -- token` and paste the new one |
| `GET /v1/models` 404 in the backend log | Harmless local environment probe. Ignore |

---

## Limitations

Honest list of what this does **not** do:

- **Single user only.** No accounts, sharing or permissions.
- **No mobile app.** Responsive web only.
- **No live photo, RAW or HEIC special handling** beyond what PIL/ffmpeg decode.
- **No reverse geocoding.** Place names would require sending locations to a
  third party. Areas are coordinate buckets.
- **No automatic duplicate deletion.** Resolving duplicates trashes the extras
  and keeps the oldest — reversible, never silent.
- **Face weights are non-commercial research licences** (InsightFace). If you
  plan to distribute this, that must be resolved first.
- **`?access_token=` appears in URLs.** See the tradeoff above.
- **Not hardened for public exposure.** Localhost or a trusted LAN only.

---

## Licence

Application code in this repository is yours to run and modify. Bundled or
downloaded model weights (`buffalo_s` / `buffalo_l`) carry their own
**non-commercial research** licences from their upstream providers — review them
before any distribution or commercial use.
