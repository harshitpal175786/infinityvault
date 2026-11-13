# Phase 8 — Settings

Audited before planning, as with earlier phases.

## What already exists

| Setting | Storage | Where it is changed |
|---|---|---|
| Theme (light / dark / system) | local | `ThemeToggle` in the top bar |
| Sidebar collapsed | localStorage | chevron in the sidebar |
| Telegram connection | backend | Telegram setup dialog |
| Access token | localStorage | token gate |
| Backup threshold / schedule | env file | not in the UI |
| Face detection model | env file | not in the UI |
| Video proxy | automatic | not in the UI |

The brief for this phase says **no new backend**. So Settings is a place that
surfaces state which already exists and is currently either scattered or
invisible, and links to the existing controls rather than duplicating them.

## Why a settings page at all

Today the answer to "is my library healthy / backed up / connected?" requires
visiting three different places: the sidebar badge for Telegram, Utilities for
integrity, and nothing at all for backup. There is no single place that answers
"am I safe?".

## Plan

One page, three sections:

1. **Status** — read-only, from endpoints that already exist:
   `/api/telegram/status`, `/api/backup/status`, `/api/integrity/status`,
   `/api/auth/status`. Each shown as a plain sentence, not a metric dump.

2. **Appearance** — theme, sidebar, reduced motion note. These reuse the
   existing controls; no new state.

3. **Maintenance** — links to the existing Utilities actions, plus the
   backup threshold explained read-only (it is an env value, and pretending to
   edit it while writing nowhere would be fake).

## Deliberate scope limits

- **No settings API, no `app_settings` writes.** Cancelled earlier and still
  correct: the table has live call sites behind auto-backup and adding a second
  writer invites divergence.
- **No editable backup threshold.** It is read from the environment at startup;
  a UI that appeared to change it without affecting the running process would
  be a lie.
- **No account or multi-user section.** Single-owner vault, documented.

## Verification

- Status lines match the raw endpoints.
- Theme and sidebar controls still work from the page.
- No console errors; grid untouched; tsc and build clean.
