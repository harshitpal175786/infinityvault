# Phase 4 — Albums and Collections

Audited both layers before writing code.

## Current state (verified)

**Backend routes that exist**

| Route | Present |
|---|---|
| `GET /api/albums` | yes |
| `POST /api/albums` | yes |
| `DELETE /api/albums/{id}` | yes |
| `POST /api/albums/{id}/media` | yes (add only) |
| Rename | **no route** |
| Remove media from album | **no route** |

**`list_albums`** returns `albums.*` plus `media_count` only. There is no cover
image, so every album is represented by a generic folder icon.

**Frontend**: `createAlbum` is wired; `deleteAlbum` is defined in `api.ts` but
**never called by any component**; `renameAlbum` and `removeFromAlbum` do not
exist. The sidebar renders albums as a flat list of buttons with no menu, no
cover, and no way to manage them.

## What Phase 4 therefore needs

### Backend
1. `PATCH /api/albums/{id}` — rename and edit description.
2. `DELETE /api/albums/{id}/media` — remove chosen items from an album without
   deleting the media itself.
3. Cover support in `list_albums`: the first item's thumbnail, so a real album
   card can show a face rather than a folder glyph.

### Frontend
4. Album grid view: cover, name, item count — replacing the bare sidebar list as
   the primary way to browse albums.
5. Rename and delete from an album card (delete already has an API, just unused).
6. Remove selected items from the current album.
7. Album detail header: cover, name, count, actions.

## Deliberate scope limits

- **No sharing or public links.** Cancelled outright, not deferred — see
  `docs/UI-UPGRADE-SCOPE-CUTS.md`. There is no permission model for it.
- **No nested albums / folders.** Immich has them; the schema has no parent
  column and adding one now would ripple through every album query.
- **Delete stays as-is**: `deleteAlbum` removes the album and its links, never
  the media.

## Plan of record

Start with the backend, because a UI cannot rename what the API cannot store.
Then the album card grid, then the in-album actions.

## Verification

- Rename persists across reload.
- Delete removes the album from the sidebar and does not delete media.
- Removing a photo from an album leaves it in the main library.
- Cover images render for albums that have items; empty albums show a fallback.
- Grid remains pixel-identical; tsc and build clean; no console errors.
