# UI Upgrade — Phase Scope Decisions

Records features that were in the original phase plan and have been **cut**, so
later phases do not quietly reintroduce them and nobody waits for work that is
not coming.

## Cut by explicit decision

### Share links / public sharing — REMOVED from Phase 7

**Status: cancelled, not deferred.**

There is no code for this. Verified: `grep` for `share_link`, `public_token`,
`/api/share` and `expires_at` across `backend/app/*.py` and
`frontend/src/**/*.ts*` returns **zero** hits. There is no share table, no token
generation, no expiry handling, and no public route.

Building it would need a permission model the vault does not have: this is a
single-owner instance where `resolve_client_id()` deliberately returns one
constant owner id, so there is no concept of "another user" for a share to be
granted to. A share link would be an unauthenticated hole punched through the
bearer-token auth added in Phase 3.

**Phase 7 therefore covers uploads, duplicates and media management only.**

### A settings/preferences API — REMOVED from Phase 8

**Status: not being built.**

Verified: no `/api/settings`, `/api/preferences`, `/api/account` or
`/api/profile` route exists. Nothing to remove because nothing was ever added.

Note for anyone reading old notes: `app_settings` is **not** unused. It is live
with six call sites behind auto-backup (`mark_library_changed`,
`clear_change_count`, `backup_state`). Only the idea of *exposing it as a
user-facing settings API* is cancelled; the table itself must stay.

**Phase 8 therefore covers the UI for state that already exists** — theme
(local), Telegram connection (`/api/telegram/*`), storage and integrity figures
(`/api/*/status`) — and adds no new backend surface.

## Explicitly retained

### `/api/thumbnails/backfill` and `/api/thumbnails/status`

Kept despite having no UI caller. Thumbnails queue automatically per upload, so
these are never needed in normal operation, but they are the **only** way to
re-queue every asset if the thumbnail queue is lost. That is a recovery path,
the same category as the disaster-recovery tooling, so it stays.

## Effect on the remaining work

| Phase | Change |
|---|---|
| 5 — People, places, AI | none |
| 6 — Search & filtering | none |
| 7 — Uploads & management | **sharing removed** |
| 8 — Settings & account | **settings backend removed** |
| 9 — Testing & optimization | none |
