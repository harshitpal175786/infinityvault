# Immich Parity Analysis — What We Can and Cannot Match

**Date:** 2026-02-14
**Reference:** `immich-app/immich` @ `87ef895`, cloned to `/tmp/immich-ref`
**Question asked:** "I need all the functionality in my project, and match the UI."

This document exists because that request cannot be satisfied literally, and
it is better to say so with numbers than to quietly deliver a fraction of it.

---

## 1. The scale difference

Measured, not estimated:

| | Immich | InfinityVault | Factor |
| --- | --- | --- | --- |
| Backend TypeScript | 62,088 lines | 1,994 (Python) | **31×** |
| Frontend | 60,664 lines | 3,421 | **18×** |
| API endpoints | 304 | 29 | **10×** |
| DB migrations | 105 | 10 tables | — |
| Backend service modules | 105 | 4 files | **26×** |
| Distinct pages | 57 | 6 views | **9×** |
| Native mobile app | yes (Flutter) | no | — |

Immich is roughly **122,000 lines** of hand-written source. It is a funded
project with multiple full-time maintainers and years of accumulated work.
That is not a rhetorical comparison — it is the actual size of what "all the
functionality" means.

---

## 2. Two blockers that are not about effort

Even with unlimited time, two things cannot be reconciled.

### 2.1 Infrastructure

Immich requires:

- PostgreSQL **with a vector extension** (`vchord` or `pgvector`) — used by
  smart search and facial recognition, with HNSW indexes on `face_search`
  and `smart_search` (both `vector(512)` columns)
- Redis (job queue transport)
- BullMQ worker processes (separate from the API server)
- A filesystem of originals plus derived thumbnail/variant trees

InfinityVault's entire premise is the opposite: **one SQLite file, one Python
process, originals in Telegram, runs on 8 GB.** Adopting the Immich stack
deletes the reason this project exists. Every design decision so far —
the serial worker, the BLOB embeddings, SQLite clustering — follows from that
premise.

### 2.2 Storage model

Immich owns its original files. InfinityVault does not: originals live in
Telegram and are fetched on demand.

This directly invalidates several features:

| Immich feature | Why it breaks here |
| --- | --- |
| HLS video transcoding | Needs a stable local video to transcode and serve segments from |
| `sharp` thumbnail pipeline | Needs the original on disk at request time |
| Integrity checks (checksum the library) | Originals are remote; "library" is a remote store |
| Storage templates (`{{y}}/{{MM}}/{{filename}}`) | No user-visible file tree exists |
| External library import | There is no external filesystem to import from |
| Read-only media locations | Same |
| Duplicate detection by filesystem walk | Remote store only |

A thumbnail pipeline **is** still possible via a local cache (`telegram-cache/`
already exists). That is the one worth building — see P2.

---

## 3. Feature-by-feature map

### Tier A — already done

| Capability | Status |
| --- | --- |
| Timeline / main gallery | ✅ |
| Albums (create, add, list) | ✅ |
| Tags (create, add, list) | ✅ |
| Favourites | ✅ |
| Archive | ✅ |
| Trash | ✅ |
| Search by name/description/folder | ✅ (server-side) |
| Light + dark theme, animated | ✅ |
| Mobile responsive drawer | ✅ |
| Background job queue (upload) | ✅ |
| Dedupe on upload | ✅ (SHA-256) |
| **Face detection + embedding + clustering (API)** | ✅ |

### Tier B — worth building next, feasible here

These deliver the largest visible value per unit of work and fit the
architecture. Recommended order.

| # | Feature | Effort | Notes |
| --- | --- | --- | --- |
| B1 | **`local_path` reconciliation** | S | P0 bug; prerequisite for everything face-related |
| B2 | **Thumbnail pipeline** | M | Cache 400px webp locally; makes the grid usable |
| B3 | **Pagination / infinite scroll** | S | `list_media` currently has no `LIMIT` |
| B4 | **Real auth (token + sessions)** | M | Currently `client_id` from localStorage is trusted |
| B5 | **People page UI** | M | Backend finished; needs grid, rename, merge, drill-down |
| B6 | **Explore page** | M | Immich-style: by-city, by-tag, by-person, "things" |
| B7 | **Map / places** | M | `media_items.latitude/longitude` already exist, unused |
| B8 | **Memories** | S | "On this day" — cheap and high emotional value |
| B9 | **Recently added view** | S | Trivial once pagination exists |
| B10 | **Duplicate finder** | S | We already have SHA-256; needs a review UI |
| B11 | **Shared album links** | M | Public read-only link key |
| B12 | **Search upgrades** | M | Date range, person, tag, place filters |
| B13 | **Utilities (large files, geolocation)** | S | Queries over existing data |

### Tier C — possible but expensive, do only if needed

| Feature | Why it is expensive |
| --- | --- |
| Video transcoding / HLS | Requires ffmpeg + durable local copies + segment serving |
| Smart search (CLIP embeddings) | Adds ~600 MB model + vector index; heavy on 8 GB |
| OCR (text in images) | Adds a model + per-image cost |
| Partner sharing | Multi-user permission model; currently single-user |
| Shared spaces | Same |
| Workflows (automation engine) | A whole sub-product |
| Storage templates | Meaningless without a local file tree |

### Tier D — will not build

| Feature | Reason |
| --- | --- |
| Multi-user + admin console + RBAC | Contradicts the private single-user design |
| Server status / Prometheus / queues UI | No cluster to monitor |
| OAuth / OIDC / passkeys | No account system, by design |
| Database backup/snapshot UI | SQLite file + Telegram backups cover this |
| Library management (external libraries) | No external filesystem |
| Mobile app (Flutter) | Separate product; not a web feature |
| Buy/paid tiers | Not a commercial product |
| `futo-backups` | Vendor-specific |

---

## 4. What "match the UI" should mean

Copying Immich's UI literally would mean importing a design for a
multi-user server product with admin panels, storage templates, and a buy
page. Most of that has no counterpart here.

**A defensible goal** — and the one already started in
`docs/prd-ui-immich-alignment.md`:

> Match Immich's **visual language and interaction patterns** for the screens
> we have: typography, spacing scale, colour tokens, tile grid, viewer
> chrome, theme behaviour. Do not clone screens for features we lack.

Already achieved: token values reconciled against real Immich source,
Inter instead of Google Sans (licensing), three breakpoints, one grid rule,
smooth theme transition. See `docs/token-reconciliation.md`.

**Remaining realistic UI work:** extract `App.tsx` (937 lines) into
components, then add the People, Explore, and Map pages using the same
tokens.

---

## 5. Recommendation

Do **Tier B in order**, starting with B1. That path adds the most
capability per hour while keeping the app lightweight and portable, and it is
the only path where "matches Immich" stays honest.

Realistic expectation: Tier B fully delivered gets us to roughly
**40–50% of Immich's user-visible features** at about **3% of its code size**.
That is a strong outcome for a private, single-user, Telegram-backed library.
Parity is not the target; sufficiency is.

If genuine parity is required, the correct answer is: run Immich itself and
use Telegram only as a backup target. That is a different project.

---

## 6. Immediate next step

B1 — `local_path` reconciliation. Small, testable, and it unblocks B5 and
repairs the existing broken row.

---

## 7. Verification notes

Claims in this document were checked against the clone, not recalled:

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/immich-app/immich.git /tmp/immich-ref
cd /tmp/immich-ref && git sparse-checkout set server/src web/src
```

- Line and endpoint counts from `wc -l` / `grep -c` over `server/src` and
  `web/src`.
- `bullmq`, `@nestjs/bullmq`, `ioredis`, `pg`, `kysely` confirmed in
  `server/package.json`.
- Vector storage confirmed at
  `server/src/schema/migrations/1744910873969-InitialMigration.ts`
  (`face_search` and `smart_search`, both `vector(512)`, HNSW indexes).
- Tier C/D service claims each confirmed by file presence in
  `server/src/services/` (transcoding, hls, ocr, smart-info, workflow,
  storage-template, partner, session, passkey).

**One correction made during review:** an earlier draft said the vector
extension was `pgvecto-rs`. The actual code supports `vchord` or `pgvector`
(`server/src/utils/database.ts:1116`). Corrected above.

**Relevant to our face work:** Immich stores **512-dimensional** face
embeddings — the same dimension our InsightFace `buffalo_s` pipeline produces.
Our cosine-similarity clustering is therefore comparable in principle; the
difference is their HNSW index in Postgres versus our linear scan over SQLite
BLOBs. Linear scan is fine at personal-library scale (thousands of faces) and
would need an index only past ~100k.
