# Phase 5 — People, Places and AI Grouping

Audited the code before planning. Most of Phase 5 already exists, so the honest
scope is much smaller than the phase title suggests.

## Already working (verified — do not rebuild)

| Capability | Evidence |
|---|---|
| People list with counts | `PeoplePage.tsx`, `face_count` |
| Face crops as avatars | `person.cover_url` → `/api/faces/{id}/thumbnail` |
| Rename a person | `PATCH /api/people/{id}`, 10 references in UI |
| Merge two people | `POST /api/people/merge`, 26 references in UI |
| Per-person photo grid | `person-photo-grid`, opens the viewer |
| Face detection + clustering | 304 faces, 153 people, auto-clusters on drain |
| Places / map with clustered pins | `ExplorePage.tsx`, 30 `map` refs, 17 `cluster` |
| Explore groups (people/places/tags) | `/api/explore/*` |

## Genuinely missing (the actual Phase 5 work)

1. **Delete or hide a person.** Confirmed absent: no `DELETE /api/people/{id}`
   and no `hidden` column anywhere. A wrongly-clustered person can only be
   renamed or merged away — there is no way to dismiss one. This is the largest
   real gap and needs backend work.
2. **Person detail is a small strip**, not a proper view: no count, no way to
   add/remove photos from a person, no confidence display.
3. **No "unassigned faces" surface.** Faces that failed to cluster are invisible,
   so the user cannot fix them.

## Plan

### Backend
1. `DELETE /api/people/{id}` — removes the person and its face rows but **never**
   the media. Mirrors the album rule.
2. `PATCH /api/people/{id}` gains `hidden`, so a person can be dismissed without
   destroying the cluster (recoverable, unlike delete).

### Frontend
3. Delete + hide actions on each person card, with a confirm that states photos
   are not affected.
4. Hidden people collapse behind a "Show hidden" toggle.
5. Person detail header gains the photo count.

## Deliberate scope limits

- **No manual face box drawing.** Immich allows it; it needs an interactive
  crop editor over the original and is a much larger piece of work than this
  phase.
- **No person cover picking.** The cover is the newest face crop; letting users
  choose is cosmetic.
- **No place naming.** Reverse geocoding was rejected earlier in the project;
  the map shows coordinates and clusters only.
- **Clustering threshold stays 0.5.** Under-merging is preferred over
  over-merging, and changing it re-clusters everything.

## Verification

- Deleting a person removes it from the list and leaves every photo intact.
- Hiding a person removes it from the default view and it returns under
  "Show hidden".
- Both survive a reload.
- Person detail shows a correct count.
- Map and explore views unchanged; grid pixel-identical; tsc and build clean.
