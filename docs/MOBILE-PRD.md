# InfinityVault Mobile — Product Requirements Document

**Status:** Draft for approval
**Target:** Android (iOS only if Android proves out)
**Backend:** the existing InfinityVault service, unchanged where possible
**Relationship to web:** sibling client, not a fork

---

## 1. Why a mobile app at all

The desktop vault answers "where are my photos stored safely?" — Telegram is the
storage, SQLite is the index, the web UI is the window.

It does not answer the question a phone asks: **"I just took a photo; is it
backed up yet?"** A vault you must return to a laptop to use is a vault you do
not use daily.

The mobile app exists to make the vault part of the moment a photo is taken.

### What this is not

Not a second photo manager. Not a sharing app. Not multi-user. The single-owner,
no-accounts model is a deliberate decision carried over from the web app and
from `backend/app/auth.py`, and nothing here reopens it.

---

## 2. Constraints inherited from the existing system

These are not preferences. They are properties of the running backend, and the
mobile app must respect them.

| Constraint | Consequence for mobile |
|---|---|
| Backend binds loopback today | **Must be reachable before anything works.** Not a UI problem. |
| Auth is one bearer token, `configured: false` today | Token must be generated and stored before first sync |
| Single owner, no accounts | No login screen, no profile, no logout semantics beyond forgetting the token |
| SQLite index, no Redis/BullMQ | No push notifications without new backend work |
| Serial job workers | Mobile must not fire parallel uploads (web already caps at 2) |
| 8 GB host machine | Thumbnail-first everywhere; never fetch originals for a grid |
| `capture_time` (not `captured_at`) | Field naming follows the schema, not intuition |

---

## 3. Verified backend surface

Confirmed against `backend/app/main.py`, not assumed.

### Browsing

- `GET /api/media` — **keyset pagination**: returns `{ items, next_cursor }`,
  never an offset. 18 query params: `view`, `search`, `album_id`, `cursor`,
  `limit`, `date_from`, `date_to`, `media_type`, `has_faces`, `has_location`,
  `camera`, `person_id`, `tag_id`, `place`, `favorite`, `sort`, `client_id`,
  `query_client_id`.
- `GET /api/memories`, `GET /api/recently-added`
- `GET /api/albums`, `GET /api/people`, `GET /api/tags`, `GET /api/cameras`
- `GET /api/explore/{people,places,tags}`, `GET /api/geo/points`
- `GET /api/people/{id}/media`

### Media bytes

- `GET /api/media/{id}/thumbnail` — **primary grid asset**
- `GET /api/media/{id}/micro-thumbnail` — tiny preview
- `GET /api/media/{id}/content` — original
- `GET /api/media/{id}/proxy` — 720p video proxy (exists, from Phase 6)
- `GET /api/faces/{id}/thumbnail`

### Writing

- `POST /api/media` — upload (one file per request)
- `PATCH /api/media/{id}` — favorite, archived, trashed, description, `captured_at`, folder
- `DELETE /api/media/{id}`
- `POST /api/media/{id}/retry`
- Albums: `POST`, `PATCH`, `DELETE`, `POST .../media`, `DELETE .../media`
- People: `PATCH`, `DELETE`, `POST /api/people/merge`

### Status

- `GET /api/health`, `/api/auth/status`, `/api/telegram/status`,
  `/api/backup/status`, `/api/integrity/status`, `/api/thumbnails/status`,
  `/api/videos/status`, `/api/faces/status`

---

## 4. Goals

| # | Goal | Measure |
|---|---|---|
| G1 | Open the app and see recent photos in under 2 seconds on LAN | first tile painted |
| G2 | Take a photo and know it is backed up without thinking | item reaches `uploaded` |
| G3 | Browse the whole library without a laptop | full keyset pagination |
| G4 | Never lose a photo due to a mobile bug | no destructive path without confirm |

## 5. Non-goals

- Multi-user, sharing links, public albums
- Photo editing
- On-device face recognition (the server already does this)
- Push notifications (needs backend work; out of scope for v1)
- iOS in v1 — Android first

---

## 6. The reachability decision (blocking, decide before Phase 1)

The backend is `127.0.0.1:8000`. A phone cannot reach it. Three options:

| Option | Security | Effort | Notes |
|---|---|---|---|
| LAN binding (`0.0.0.0`) | Anyone on the network can reach it | low | Only acceptable with a token configured and trusted Wi-Fi |
| Tailscale | Private mesh, device-authenticated | low-medium | **Recommended**: no port forwarding, no public exposure |
| Public tunnel | Highest risk | medium | Not recommended for a personal vault |

**Recommendation: Tailscale**, plus generating the access token that currently
does not exist. This is Phase 1, and nothing else can be tested without it.

---

## 7. Phases

Each phase ends with something demonstrable on a real device. No phase is
"infrastructure only" except Phase 1, which unblocks everything.

### Phase 1 — Reachability and auth
Token generated, backend reachable from a phone, `/api/health` and
`/api/auth/status` answering. **Nothing else can start before this.**
Deliverable: a curl-equivalent that runs on the phone.

### Phase 2 — App shell and secure token storage
Expo project, secure storage for the token, connection status screen, theme
tokens ported from `tokens.css`. App launches, proves it can authenticate, shows
a plain list of one row per photo.

### Phase 3 — Timeline grid
Thumbnail-first grid, keyset infinite scroll, no duplicate fetches, placeholder
on failure. This is the phase where the app becomes usable.

### Phase 4 — Viewer
Full-screen swipe, zoom/pan, video via proxy, favourite toggle, metadata panel.
Photos must never show a duration (a bug already fixed on web — do not
reintroduce it).

### Phase 5 — Search and filters
The 18 params, debounced search, filter sheet, empty states. Server-side search
already covers name, description and folder.

### Phase 6 — Upload and camera-roll backup
The reason the app exists. Bounded concurrency (2, matching web), real byte
progress, retry, and a clear "is my library safe" state. Must integrate with
`POST /api/media`.

### Phase 7 — Albums, people, favourites
Browse and curate: albums with covers, people clusters, favourite/archive/trash.

### Phase 8 — Settings and diagnostics
Status from the existing endpoints, connection troubleshooting, token
management. Mirrors the web Settings page.

### Phase 9 — Offline cache and performance
On-disk thumbnail cache, optimistic UI, cold-start budget. Only after the
above works.

### Phase 10 — Release
Signed APK, versioning, dist.

---

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No token configured today | App cannot authenticate | Phase 1, before any UI |
| Backend unreachable from phone | Nothing works | Settle transport first |
| Camera-roll sync uploads duplicates | Library pollution | Server already checksums; verify before trusting |
| Battery drain from background sync | App gets uninstalled | WorkManager with sane constraints |
| Contract drift from web | Silent breakage | Copy `api.ts`/`types.ts`; assert response shape in dev |
| Single 8 GB host | Slow thumbnails | Thumbnail-first, never originals in grid |

---

## 9. Shared code policy

Measured split:

- **~750 lines shareable**: `api.ts` (575), `types.ts` (44), `lib/format.ts` (127)
- **~5 000 lines not shareable**: all components and hooks

`api.ts` touches DOM-only APIs in 8 places (`window.localStorage`,
`XMLHttpRequest`), so it needs a port, not a copy-paste.

**Decision: separate repo, copied files, no shared package.** Revisit only if
the same bug is fixed twice more than once.

---

## 10. Definition of done for v1

- Photos taken today appear in the app within a minute of being backed up
- The whole library is browsable by scrolling
- Favourites and albums work
- A failed upload is visible and retryable
- The app survives the backend being offline without losing local state
- Nothing can delete a photo without an explicit confirmation
