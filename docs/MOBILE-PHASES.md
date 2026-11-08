# InfinityVault Mobile — Phase Plan

Companion to `docs/MOBILE-PRD.md`. Each phase lists its exit criteria so there is
no ambiguity about "done".

Rule carried over from the web upgrade: **one phase at a time, stop and report.**

---

## Phase 1 — Reachability and auth

The blocker. Nothing else is testable until a phone can reach the backend and
authenticate.

Tasks:
1. Generate a real access token (`npm run infinityvault -- token` on the host).
2. Choose transport (recommendation: Tailscale) and make the backend reachable.
3. Confirm `/api/health` and `/api/auth/status` from the phone's browser.
4. Confirm an authenticated `GET /api/media?limit=2` from the phone.

Exit criteria:
- Phone returns `{"status":"ok"}`
- Authenticated media request succeeds from the phone
- Unauthenticated request is rejected (proves auth is actually on)

**Do not proceed until all three pass.**

---

## Phase 2 — App shell and token storage

Tasks:
1. Create `infinityvault-mobile` repo (Expo + TypeScript).
2. Secure token storage (`expo-secure-store`).
3. Port `tokens.css` values to a Dart-free TS theme module (light/dark).
4. Connection screen: base URL, token, test-connection button.
5. Port `types.ts` and a minimal `api.ts` (fetch only; drop XHR for now).

Exit criteria:
- App launches on device, stores token, survives restart
- Shows connection state honestly (connected / unreachable / bad token)
- A test fetch returns real media count

---

## Phase 3 — Timeline grid

The phase where it becomes a photo app.

Tasks:
1. FlatList tuned for images (`getItemLayout`, fixed tile size).
2. Keyset infinite scroll using `next_cursor` — no offsets.
3. Thumbnail-first via `/thumbnail`; never request `/content` in the grid.
4. Loading, empty, and failure states per tile (not one global error).
5. Cap concurrency on image loading.

Exit criteria:
- Scrolls a full library (378+ items) without duplicate or dropped pages
- No full originals fetched during a scroll
- A broken thumbnail shows a placeholder, not a broken icon

---

## Phase 4 — Viewer

Tasks:
1. Full-screen pager, swipe between items.
2. Pinch/pan zoom with clamp (mirror `useZoomPan` behaviour, not its code).
3. Video playback via `/proxy`; photos must show **no** duration field.
4. Favourite toggle -> `PATCH /api/media/{id}`.
5. Metadata panel: date, camera, size, dimensions.

Exit criteria:
- Swipe and zoom feel native
- Favourite persists after restart
- Photos show no duration; videos do

---

## Phase 5 — Search and filters

Tasks:
1. Debounced search input (the web app already does this — mirror the 250 ms).
2. Server-side search call, not client filtering.
3. Filter sheet: date range, type, favourite, person, album, camera, sort.
4. Search-specific empty state with a clear action.

Exit criteria:
- A hopeless query shows a real message, not a blank grid
- Filters compose with search
- Filter state survives backing out of the viewer

---

## Phase 6 — Upload and camera-roll backup

The reason the app exists. Highest risk phase.

Tasks:
1. Bounded upload queue, **max 2 concurrent** (matches web, protects the host).
2. Real byte progress (`expo-file-system` upload task).
3. Retry per item and retry-all.
4. Queue summary surface: uploading / waiting / failed.
5. Verify server-side checksum dedupe before enabling bulk sync.
6. Explicit consent screen before the first full camera-roll sync.

Exit criteria:
- 10 photos upload, max 2 at a time, all reach `uploaded`
- A deliberately failed upload is visible and retryable
- Re-uploading the same file does not create a duplicate
- No photo is deleted or moved on the device, ever

---

## Phase 7 — Albums, people, favourites

Tasks:
1. Album list with covers, album detail grid.
2. Add/remove media from album; rename; delete album (confirm).
3. People list, person media, hide/remove.
4. Favourites / archive / trash views.

Exit criteria:
- Album membership changes persist to the server
- Removing from an album never deletes the photo
- Trash is reversible

---

## Phase 8 — Settings and diagnostics

Tasks:
1. Status rows from existing endpoints (Telegram, backup, integrity, auth).
2. Connection troubleshooting: which of host/token/network failed.
3. Change server URL; clear token.
4. Read-only display of backend-side settings (same honesty rule as web:
   do not show editable controls for env values).

Exit criteria:
- Each status row matches the raw endpoint
- Misconfiguration is diagnosable without reading logs

---

## Phase 9 — Offline cache and performance

Tasks:
1. Disk thumbnail cache with eviction.
2. Optimistic favourite/trash toggles with rollback on failure.
3. Cold-start budget measurement.
4. Reduced-motion respect.

Exit criteria:
- Reopening offline shows cached thumbnails, not empty states
- Cold start to first tile measured and recorded
- Failed optimistic update reverts visibly

---

## Phase 10 — Release

Tasks:
1. App icon, splash, name "InfinityVault Mobile".
2. Versioning and changelog.
3. Signed APK; install on a clean device.
4. Document how to point a new device at the vault.

Exit criteria:
- Installs on a fresh device and connects with only a URL and a token
- No dev-only UI visible in a release build

---

## Ordering rationale

Phase 1 blocks everything: without a reachable, authenticated backend there is
nothing to build against. Phase 3 (grid) comes before Phase 6 (upload) because
reading proves the API contract cheaply, while uploads carry the destructive risk
and deserve the most caution.
