# Phase 7 — Uploads and Media Management

Audited before planning. Uploads largely work; two real defects and one genuine
gap, and one planned feature removed by your earlier decision.

## Already working (verified — do not rebuild)

| Capability | Evidence |
|---|---|
| Drag-and-drop + file picker | `handleDrop`, `handleFileChange`, `drop-zone` |
| EXIF extraction on upload | `capturedAt`, `sourceLabel`, width/height, GPS |
| Local preview before backup | `createMediaItem`, blob URLs |
| Retry a failed upload | `handleRetry`, `POST /api/media/{id}/retry` |
| Failure keeps the item visible | `uploadError`, tile stays `local` |
| Duplicate detection and resolution | `/api/duplicates`, wired in `ExplorePage` |
| Selection actions | favourite, archive, trash, album, tag, download, delete-forever |
| Trash / restore | `updateSelectedItems({ trashed })`, `RotateCcw` |
| Large-file and location-gap utilities | `/api/utilities/*`, `UtilitiesPage` |

## The measured defects

### 1. Uploads are fired all at once, with no limit

`addFiles` does `validItems.forEach((item) => void syncItem(item))`. Dropping
40 files starts **40 simultaneous uploads**. Each one streams a full-size
original to the backend, which then has to hand it to Telegram. On an 8 GB
machine this is exactly the contention the project has been avoiding
elsewhere — the whole job system is serial precisely to prevent it.

Not fixed by the backend, because the backend accepts one file per request and
cannot see the rest of the batch.

### 2. No upload progress

`uploadMedia` uses `fetch`, which has no upload progress event. A large video
shows only a static "queued" tile and then jumps to done. There is no way to
tell a slow upload from a stalled one — the same failure mode that caused the
phantom "stuck queue" earlier in this project.

`XMLHttpRequest` has `upload.onprogress`. Using it for this one call site is the
smallest change that gives real byte progress.

## Plan

1. **Bound concurrency** to a small queue (2 at a time) with the remainder
   waiting, so a large drop stays responsive and does not swamp the machine.
2. **Real byte progress** per item via XHR, shown on the tile.
3. **Queue summary** in the header: n uploading, n waiting, n failed, with a
   retry-all for failures.

## Deliberate scope limits

- **No sharing or public links.** Cut from the plan by explicit decision; see
  `docs/UI-UPGRADE-SCOPE-CUTS.md`.
- **No resumable/chunked upload.** The backend takes a whole file per request.
  Chunking needs a new upload-session endpoint, which is a larger change than
  this phase and pointless while files are photos.
- **No client-side duplicate pre-check.** Server-side checksum detection already
  covers it.

## Verification

| Check | Result |
|---|---|
| Max 2 uploads at once | **yes** — 2 tiles in `queued` while 6 files were queued |
| Queue summary | **"2 uploading"** rendered while work was in flight |
| Summary hides when idle | yes |
| Uploads still complete | 6 files → 216 tiles, no errors |
| `upload.onprogress` wiring | **1 event, `3000179/3000179`, lengthComputable true** |
| Grid geometry | `260,248,192,192` unchanged |

Two honest caveats:

**The progress bar is invisible on localhost.** A 3 MB upload reaches the server
in a single progress event, so there is no intermediate state to draw. I
confirmed the handler fires with correct byte totals; it will show real movement
over a slow link, and I could not reproduce that condition locally because CDP
throttling would not attach in headed Chromium. The value here is diagnostic
rather than cosmetic.

**My first measurement was wrong.** I counted Playwright `request` events and
concluded the limit was leaking (peak 3, not 2). Playwright emits `request` when
the request object is created, before the queue gate. Counting tiles actually in
`queued` state gave the true answer, 2.
