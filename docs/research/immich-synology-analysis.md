# Immich and Synology Photos research

## Scope

This report records a feature and architecture investigation for extending
InfinityVault toward the capabilities exposed by Immich and Synology Photos
while keeping Telegram Saved Messages as the original-file storage backend.

The investigation used public Immich source and documentation, official
Synology documentation, an APK downloaded from Synology's official archive,
and the official REA repository/tooling. No Immich or Synology source, APK
contents, or decompiled code has been added to InfinityVault.

## Research artifacts

Artifacts were kept outside the repository at:

```text
/private/var/folders/wl/0yy73n255bs9hb7znvcqvfcr0000gn/T/infinityvault-research/
```

| Artifact | Source | Result |
| --- | --- | --- |
| Immich source | `https://github.com/immich-app/immich` | Shallow, sparse checkout at commit `4f46fc0dfaf15ad9963275a42137b5c9ae38c556` |
| REA source | `https://github.com/morluto/rea` | Main archive, REA 6.8.0 source |
| Synology Photos APK | Official Synology archive, version `2.2.0-556.ww` | Downloaded; SHA-256 `f8887acfb3bc0bdbb853a31dbd5dfacbc5ea84dbcd2a7fea0a0a27f2c17c9955` |
| JADX bridge | REA-pinned `jadx-headless-mcp-0.7.1-all.jar` | SHA-256 verified as `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75` |

Official Synology APK URL:

```text
https://global.synologydownload.com/download/Mobile/Android-Photos/2.2.0-556/Android-SynologyPhotos.2.2.0-556.ww.apk
```

## Evidence and limitations

REA successfully inspected the APK signature. The APK declares a Synology
certificate, uses APK v2 signing, and its content digest is internally
consistent. The inspection was static and did not execute the APK or contact a
device.

REA's full JADX APK inspection could not complete on this Mac because:

- the host has Node `26.3.0`, below REA 6.8.0's declared minimum of `26.12.1`;
- the installed Apple Swift compiler and SDK have mismatched Swift module
  versions, preventing REA's macOS process-ownership helper from compiling.

The APK was therefore used for limited static inventory and string evidence.
Synology's official documentation remains the authoritative source for its
user-visible behavior. A complete REA/JADX pass can be repeated after updating
Node and selecting a matching Xcode/Swift toolchain.

## Immich implementation patterns

The most useful Immich patterns are architectural rather than visual:

1. **Asset as the central record.** An asset stores owner, original filename,
   capture time, file modification time, checksum, dimensions, media type,
   favorite state, visibility, trash state, stack membership, duplicate group,
   and optional Live Photo relationship.
2. **Virtual organization.** Albums, tags, people, stacks, memories, and
   shared links reference assets. The original asset is not duplicated when it
   is added to multiple albums.
3. **Metadata-first APIs.** Timeline buckets return compact date/count data;
   individual time buckets are loaded on demand. This supports virtualized
   timelines with large libraries.
4. **Separate search modes.** Metadata search handles filename, date, camera,
   location, media type, rating, archive, favorite, album, person, and tag
   filters. Smart search is a separate ML/vector operation. OCR is another
   explicit search mode.
5. **Background jobs.** Upload processing, metadata extraction, thumbnails,
   machine learning, duplicate detection, and notifications are independent
   jobs with observable states.
6. **Permission boundaries.** Album, asset, person, map, shared-link, and
   administration operations have separate permission checks.
7. **Event-driven timeline.** Websocket events update the timeline when an
   asset, album, stack, archive state, or upload changes.

Relevant Immich source areas inspected:

```text
server/src/controllers/album.controller.ts
server/src/controllers/search.controller.ts
server/src/controllers/timeline.controller.ts
server/src/controllers/memory.controller.ts
server/src/controllers/map.controller.ts
server/src/controllers/shared-link.controller.ts
server/src/controllers/duplicate.controller.ts
server/src/controllers/stack.controller.ts
server/src/controllers/person.controller.ts
server/src/controllers/partner.controller.ts
server/src/repositories/asset.repository.ts
server/src/repositories/album.repository.ts
server/src/schema/tables/asset.table.ts
server/src/schema/tables/album.table.ts
server/src/schema/tables/shared-link.table.ts
web/src/lib/managers/timeline-manager/
web/src/lib/managers/search-manager.svelte.ts
```

## Synology Photos capability evidence

Synology documentation describes these behaviors:

- timeline view and folder view;
- personal space and shared space;
- manual albums and conditional albums;
- automatic People, Subjects, Similar Items, Places, Tags, Videos, and
  Recently Added albums;
- date/time, description, tag, rating, and face editing;
- search by filename, date, people, subject, location, camera, lens, and
  tags;
- backup queue, backup status, focused backup, and free-up-space flows;
- password-protected and expiring share links;
- collaborative albums and upload-capable photo request links;
- offline cache, slideshow, Chromecast/AirPlay, Live Photos, RAW, and 360°
  media support.

Limited APK string inventory independently exposed terms for albums, backup
status, upload queue, personal/shared space, favorites, tags, people, map
view, search, 360° playback, downloads, folders, and upload limits. These
strings identify product concepts, but do not prove the complete runtime
behavior or internal implementation.

The pinned JADX bridge was also run directly in its own local MCP server,
which avoided REA's macOS process-ownership helper. It confirmed:

- package `com.synology.projectkailash`, version `2.2.0` / build `556`,
  minimum SDK 29, target SDK 34;
- explicit media-library, location, foreground data-sync, boot receiver,
  notification, wake-lock, biometric, and Synology backup permissions;
- dedicated upload picker, upload queue, photo-backup status, timeline,
  folder, search, smart-album, people, map, lightbox, and photo-request
  application components;
- `UploadTaskManager`, `PhotoBackupProvider`, and an ObjectBox-backed
  `UploadQueueTable` with queue operations such as add, add-all, peek, pop,
  remove, size, and URI lookup;
- timeline operations that include view-mode switching, selection deletion,
  and an explicit “backup selected item now” action;
- smart-album state for personal/team libraries and map-view mode;
- search state with keyword suggestions, history deletion, album selection,
  and selection actions.

JADX reported expected reconstruction warnings in bundled third-party code
(Fresco, Glide, AndroidX, Media3, and Kotlin/runtime classes), including a few
control-flow overflow cases. Those warnings affect decompiled source fidelity
for those dependencies; the project-specific class inventory, manifest, string
resources, method signatures, and queue/state relationships remain useful
behavior evidence.

This confirms that the most important Synology mobile behavior is a durable
local upload queue plus a separate metadata/library presentation layer. In
InfinityVault, `upload_jobs` is the server-side equivalent of the Synology
queue and should gain explicit priority, cancellation, progress, and
focused-upload operations.

## Telegram-backed InfinityVault design

Telegram should be treated as an object-storage adapter, not as the gallery
database:

```text
InfinityVault database
  users and sessions
  assets and metadata
  albums, tags, people, stacks, memories
  search indexes and ML results
  sharing permissions and links
  upload/download/job state
           |
           v
Telegram Saved Messages adapter
  send original
  resolve message ID
  stream original
  retry/rate-limit handling
```

Each asset needs a stable local ID and a Telegram locator. The locator should
include the owning InfinityVault user, Telegram account identity, Saved
Messages message ID, original filename, MIME type, and checksum. Albums and
tags should only reference the local asset ID, so adding an asset to several
albums never uploads another copy.

Telegram-specific constraints must remain visible in the product:

- individual file limits are 2 GB for free accounts and 4 GB for Premium;
- rate limits and transient disconnects require resumable jobs and backoff;
- Telegram message deletion or account disconnection can make an original
  unavailable even when local metadata remains;
- public links must authorize every request through InfinityVault before
  streaming a Telegram original;
- multi-user support requires real InfinityVault authentication and one
  encrypted Telegram session per user.

## Proposed data model additions

The existing `media_items` table can evolve into an asset model with these
fields:

```text
asset
  id, user_id, original_name, media_type, mime_type, size_bytes
  captured_at, modified_at, capture_source, width, height, duration
  checksum, checksum_algorithm, local_path
  telegram_account_id, telegram_message_id
  is_favorite, visibility, deleted_at, archived_at
  stack_id, duplicate_group_id, created_at, updated_at

album, album_asset
tag, asset_tag
person, face
memory, memory_asset
shared_link, shared_link_asset, shared_link_user
upload_job, metadata_job, ml_job
```

SQLite is enough for the first single-user phase. PostgreSQL becomes the right
choice when real multi-user sharing, full-text search, vector search, and
background workers are introduced.

## Implementation order

### Phase 1: organization foundation

- replace browser-only client identity with application authentication;
- add asset checksum and duplicate prevention;
- add favorites, archive, trash, restore, and permanent deletion;
- add albums without duplicating files;
- add tags and editable descriptions/capture dates;
- add folder metadata and a folder-view screen;
- add timeline buckets and virtualized loading.

### Phase 2: discovery

- add camera and GPS EXIF persistence;
- add metadata filters and search suggestions;
- add map/Places view;
- add Memories and “on this day” queries;
- add exact duplicate groups and manually managed stacks;
- add background thumbnail and metadata jobs.

The mobile backup evidence adds these Phase 1 queue requirements:

- queue rows must survive app/backend restarts;
- each row needs queued, active, complete, failed, and retryable states;
- a user can prioritize one asset immediately;
- queue size, per-item progress, and failure reason are readable;
- duplicate URI/checksum detection happens before creating another upload;
- upload settings can select a source scope and destination policy.

### Phase 3: sharing and collaboration

- add users, roles, sessions, and per-user Telegram accounts;
- add shared albums with viewer/contributor permissions;
- add password-protected, expiring public links;
- add partner sharing with an explicit timeline inclusion setting;
- add audit logs and share revocation.

### Phase 4: machine learning and mobile

- add face detection, people clustering, naming, merge, and reassignment;
- add subject/object recognition;
- add OCR and searchable text;
- add CLIP/vector search as an optional worker;
- add PWA/native background backup and offline cache;
- add Live Photo pairing, RAW previews, 360° viewers, slideshow, and casting.

## Licensing and reuse boundary

Immich is AGPL-3.0 licensed. Its source and architecture can be studied, but
copying or adapting its code into InfinityVault would create licensing and
source-distribution obligations that must be handled deliberately. Synology
Photos is proprietary; its APK and decompiled implementation must not be
copied into InfinityVault. This project will implement independently from
documented behavior and observed interfaces.

## Recommended next coding slice

Start with Phase 1's **albums, favorites, archive, trash, checksums, and
metadata editing**. These features provide the largest Immich/Synology value,
fit the current SQLite/React/FastAPI stack, and do not require ML models or a
mobile application. Telegram remains unchanged as the original-file adapter.
