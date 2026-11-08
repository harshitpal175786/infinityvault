import base64
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
CACHE_DIR = DATA_DIR / "telegram-cache"
THUMB_DIR = DATA_DIR / "thumbnails"
PROXY_DIR = DATA_DIR / "video-proxies"
THUMB_LONGEST_EDGE = 400
MICRO_LONGEST_EDGE = 32
DB_PATH = Path(os.getenv("INFINITYVAULT_DB_PATH", DATA_DIR / "infinityvault.db"))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def open_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    PROXY_DIR.mkdir(parents=True, exist_ok=True)
    with closing(open_db()) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS telegram_connections (
                client_id TEXT PRIMARY KEY,
                encrypted_session TEXT NOT NULL,
                telegram_user_id INTEGER NOT NULL,
                display_name TEXT NOT NULL,
                username TEXT,
                connected_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS media_items (
                id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                original_name TEXT NOT NULL,
                media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'video')),
                mime_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                capture_time TEXT NOT NULL,
                capture_source TEXT NOT NULL,
                width INTEGER,
                height INTEGER,
                duration REAL,
                local_path TEXT NOT NULL,
                checksum TEXT,
                telegram_message_id INTEGER,
                upload_status TEXT NOT NULL,
                upload_error TEXT,
                upload_attempts INTEGER NOT NULL DEFAULT 0,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                is_archived INTEGER NOT NULL DEFAULT 0,
                trashed_at TEXT,
                description TEXT NOT NULL DEFAULT '',
                folder_path TEXT,
                latitude REAL,
                longitude REAL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS upload_jobs (
                id TEXT PRIMARY KEY,
                media_id TEXT NOT NULL UNIQUE REFERENCES media_items(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS albums (
                id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(client_id, name)
            );

            CREATE TABLE IF NOT EXISTS album_media (
                album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
                media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
                added_at TEXT NOT NULL,
                PRIMARY KEY(album_id, media_id)
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(client_id, name)
            );

            CREATE TABLE IF NOT EXISTS media_tags (
                media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
                tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                added_at TEXT NOT NULL,
                PRIMARY KEY(media_id, tag_id)
            );

            CREATE INDEX IF NOT EXISTS media_items_client_time
                ON media_items(client_id, capture_time DESC);
            CREATE INDEX IF NOT EXISTS upload_jobs_status
                ON upload_jobs(status, updated_at);

            /* --- Face recognition (optional feature) -------------------
               Independent of the Telegram path: media_items stays the
               asset record and faces only ever reference it. */
            CREATE TABLE IF NOT EXISTS people (
                id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                name TEXT,
                cover_face_id TEXT,
                face_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS faces (
                id TEXT PRIMARY KEY,
                client_id TEXT NOT NULL,
                media_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
                person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
                bbox_x REAL NOT NULL,
                bbox_y REAL NOT NULL,
                bbox_w REAL NOT NULL,
                bbox_h REAL NOT NULL,
                det_score REAL NOT NULL,
                embedding BLOB NOT NULL,
                embedding_dim INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS face_jobs (
                id TEXT PRIMARY KEY,
                media_id TEXT NOT NULL UNIQUE REFERENCES media_items(id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS faces_client_media
                ON faces(client_id, media_id);
            CREATE INDEX IF NOT EXISTS faces_person
                ON faces(person_id);
            CREATE INDEX IF NOT EXISTS face_jobs_status
                ON face_jobs(status, updated_at);
            CREATE INDEX IF NOT EXISTS people_client
                ON people(client_id, face_count DESC);
            """
        )
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS app_settings (
                client_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (client_id, key)
            );
            CREATE TABLE IF NOT EXISTS thumbnail_jobs (
                id TEXT PRIMARY KEY,
                media_id TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'queued',
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS thumbnail_jobs_status
                ON thumbnail_jobs(status, updated_at);
            """
        )
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(media_items)")}
        migrations = {
            "checksum": "ALTER TABLE media_items ADD COLUMN checksum TEXT",
            "is_favorite": "ALTER TABLE media_items ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
            "is_archived": "ALTER TABLE media_items ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0",
            "trashed_at": "ALTER TABLE media_items ADD COLUMN trashed_at TEXT",
            "description": "ALTER TABLE media_items ADD COLUMN description TEXT NOT NULL DEFAULT ''",
            "folder_path": "ALTER TABLE media_items ADD COLUMN folder_path TEXT",
            "latitude": "ALTER TABLE media_items ADD COLUMN latitude REAL",
            "longitude": "ALTER TABLE media_items ADD COLUMN longitude REAL",
            "camera_make": "ALTER TABLE media_items ADD COLUMN camera_make TEXT",
            "camera_model": "ALTER TABLE media_items ADD COLUMN camera_model TEXT",
            "lens_model": "ALTER TABLE media_items ADD COLUMN lens_model TEXT",
            "file_state": "ALTER TABLE media_items ADD COLUMN file_state TEXT NOT NULL DEFAULT 'present'",
            "thumb_state": "ALTER TABLE media_items ADD COLUMN thumb_state TEXT NOT NULL DEFAULT 'pending'",
            "proxy_state": "ALTER TABLE media_items ADD COLUMN proxy_state TEXT NOT NULL DEFAULT 'pending'",
            "integrity_state": "ALTER TABLE media_items ADD COLUMN integrity_state TEXT",
            "integrity_checked_at": "ALTER TABLE media_items ADD COLUMN integrity_checked_at TEXT",
        }
        for column, statement in migrations.items():
            if column not in columns:
                connection.execute(statement)

        # Telegram albums are imported as albums, so an imported album needs a
        # stable key: two albums can legitimately share a display name, but a
        # grouped_id identifies exactly one burst on one account.
        album_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(albums)")
        }
        if "origin_group" not in album_columns:
            connection.execute("ALTER TABLE albums ADD COLUMN origin_group TEXT")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS media_items_client_state ON media_items(client_id, is_archived, trashed_at, is_favorite)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS media_items_client_checksum ON media_items(client_id, checksum)"
        )
        connection.commit()


def save_telegram_connection(
    client_id: str,
    encrypted_session: str,
    telegram_user_id: int,
    display_name: str,
    username: str | None,
) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            """
            INSERT INTO telegram_connections
                (client_id, encrypted_session, telegram_user_id, display_name, username, connected_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_id) DO UPDATE SET
                encrypted_session = excluded.encrypted_session,
                telegram_user_id = excluded.telegram_user_id,
                display_name = excluded.display_name,
                username = excluded.username,
                connected_at = excluded.connected_at
            """,
            (client_id, encrypted_session, telegram_user_id, display_name, username, utc_now()),
        )
        connection.commit()


def get_telegram_connection(client_id: str) -> sqlite3.Row | None:
    with closing(open_db()) as connection:
        return connection.execute(
            "SELECT * FROM telegram_connections WHERE client_id = ?",
            (client_id,),
        ).fetchone()


def delete_telegram_connection(client_id: str) -> None:
    with closing(open_db()) as connection:
        connection.execute("DELETE FROM telegram_connections WHERE client_id = ?", (client_id,))
        connection.commit()


def clean_camera_field(value: str | None) -> str | None:
    """Normalise an EXIF camera string.

    Cameras pad these with NUL bytes and trailing spaces, and plenty of exports
    write "   " instead of omitting the tag. Storing that would create filter
    options that render as blank.
    """
    if not value:
        return None
    cleaned = str(value).replace("\x00", " ").strip()
    if not cleaned:
        return None
    return cleaned[:100]


def normalize_coordinates(
    latitude: float | None, longitude: float | None
) -> tuple[float | None, float | None]:
    """Reject impossible or null-island coordinates.

    EXIF writers emit 0,0 when there is no fix. Storing that would place a pin
    in the Gulf of Guinea, which is worse than showing nothing on the map.
    """
    if latitude is None or longitude is None:
        return None, None
    try:
        lat = float(latitude)
        lon = float(longitude)
    except (TypeError, ValueError):
        return None, None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None, None
    if lat == 0.0 and lon == 0.0:
        return None, None
    return lat, lon


def create_media(
    client_id: str,
    original_name: str,
    media_type: str,
    mime_type: str,
    size_bytes: int,
    capture_time: str,
    capture_source: str,
    width: int | None,
    height: int | None,
    duration: float | None,
    local_path: str,
    checksum: str,
    latitude: float | None = None,
    longitude: float | None = None,
    camera_make: str | None = None,
    camera_model: str | None = None,
    lens_model: str | None = None,
) -> str:
    media_id = str(uuid4())
    now = utc_now()
    latitude, longitude = normalize_coordinates(latitude, longitude)
    with closing(open_db()) as connection:
        connection.execute(
            """
            INSERT INTO media_items
                (id, client_id, original_name, media_type, mime_type, size_bytes,
                capture_time, capture_source, width, height, duration, local_path, checksum,
                latitude, longitude, camera_make, camera_model, lens_model,
                upload_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
            """,
            (
                media_id,
                client_id,
                original_name,
                media_type,
                mime_type,
                size_bytes,
                capture_time,
                capture_source,
                width,
                height,
                duration,
                local_path,
                checksum,
                latitude,
                longitude,
                clean_camera_field(camera_make),
                clean_camera_field(camera_model),
                clean_camera_field(lens_model),
                now,
                now,
            ),
        )
        connection.execute(
            """
            INSERT INTO upload_jobs (id, media_id, status, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?)
            """,
            (str(uuid4()), media_id, now, now),
        )
        connection.commit()
    return media_id


def get_media(media_id: str, client_id: str) -> sqlite3.Row | None:
    with closing(open_db()) as connection:
        return connection.execute(
            "SELECT * FROM media_items WHERE id = ? AND client_id = ?",
            (media_id, client_id),
        ).fetchone()


def find_media_by_checksum(client_id: str, checksum: str) -> sqlite3.Row | None:
    with closing(open_db()) as connection:
        return connection.execute(
            "SELECT * FROM media_items WHERE client_id = ? AND checksum = ? ORDER BY created_at LIMIT 1",
            (client_id, checksum),
        ).fetchone()


def get_media_by_id(media_id: str) -> sqlite3.Row | None:
    with closing(open_db()) as connection:
        return connection.execute(
            "SELECT * FROM media_items WHERE id = ?",
            (media_id,),
        ).fetchone()


def list_media(
    client_id: str,
    view: str = "library",
    query: str | None = None,
    album_id: str | None = None,
    **filters: Any,
) -> list[sqlite3.Row]:
    """Unpaged listing. Kept for the pre-pagination response shape.

    Accepts the same filters as list_media_page so the two paths cannot drift
    into returning different results for the same query.
    """
    state_filter = {
        "library": "trashed_at IS NULL AND is_archived = 0",
        "favorites": "trashed_at IS NULL AND is_favorite = 1",
        "archive": "trashed_at IS NULL AND is_archived = 1",
        "trash": "trashed_at IS NOT NULL",
        "all": "1 = 1",
    }.get(view, "trashed_at IS NULL AND is_archived = 0")
    search_filter = ""
    parameters: list[Any] = [client_id]
    album_filter = ""
    if album_id:
        album_filter = "AND id IN (SELECT media_id FROM album_media WHERE album_id = ?)"
        parameters.append(album_id)
    if query and query.strip():
        search_filter = "AND (LOWER(original_name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(COALESCE(folder_path, '')) LIKE ?)"
        term = f"%{query.strip().lower()}%"
        parameters.extend([term, term, term])
    filter_fragments, filter_parameters = build_media_filters(**filters)
    parameters.extend(filter_parameters)
    order = "ASC" if filters.get("sort") == "oldest" else "DESC"
    with closing(open_db()) as connection:
        return list(connection.execute(
            f"SELECT * FROM media_items WHERE client_id = ? AND {state_filter} "
            f"{album_filter} {search_filter} {''.join(filter_fragments)} "
            f"ORDER BY capture_time {order}",
            parameters,
        ).fetchall())


DEFAULT_PAGE_SIZE = 200
MAX_PAGE_SIZE = 1000


def encode_cursor(capture_time: str, media_id: str) -> str:
    """Opaque keyset cursor. Base64 so callers treat it as a token, not fields."""
    raw = f"{capture_time}\x1f{media_id}".encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii")


def decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        capture_time, media_id = raw.split("\x1f", 1)
    except Exception as exc:
        raise ValueError("Invalid pagination cursor") from exc
    return capture_time, media_id


def build_media_filters(
    *,
    date_from: str | None = None,
    date_to: str | None = None,
    media_type: str | None = None,
    has_faces: bool | None = None,
    has_location: bool | None = None,
    camera: str | None = None,
    person_id: str | None = None,
    tag_id: str | None = None,
    place: str | None = None,
    favorite: bool | None = None,
) -> tuple[list[str], list[Any]]:
    """SQL fragments for the library filters.

    Returns (clauses, parameters) so callers can splice them into their own
    query without duplicating the column names or placeholder order.
    """
    clauses: list[str] = []
    parameters: list[Any] = []

    if date_from:
        clauses.append("AND capture_time >= ?")
        parameters.append(date_from)
    if date_to:
        # Inclusive end-of-day: callers pass a plain date, and a photo at
        # 23:59 on that day must still match.
        clauses.append("AND capture_time <= ?")
        parameters.append(date_to if "T" in date_to else f"{date_to}T23:59:59.999Z")

    if media_type in {"photo", "video"}:
        clauses.append("AND media_type = ?")
        parameters.append(media_type)

    if has_faces is True:
        clauses.append("AND EXISTS (SELECT 1 FROM faces WHERE faces.media_id = media_items.id)")
    elif has_faces is False:
        clauses.append("AND NOT EXISTS (SELECT 1 FROM faces WHERE faces.media_id = media_items.id)")

    if has_location is True:
        clauses.append("AND latitude IS NOT NULL AND longitude IS NOT NULL")
    elif has_location is False:
        clauses.append("AND (latitude IS NULL OR longitude IS NULL)")

    if camera:
        # Match a make/model pair, so "Apple" selects every iPhone while
        # "Apple iPhone 15 Pro" selects just that body.
        clauses.append("AND (camera_make = ? OR camera_model = ?)")
        parameters.extend([camera, camera])

    if person_id:
        # EXISTS rather than a join: a photo with several matching faces must
        # still appear once, and a join would duplicate the row.
        clauses.append(
            "AND EXISTS (SELECT 1 FROM faces WHERE faces.media_id = media_items.id "
            "AND faces.person_id = ?)"
        )
        parameters.append(person_id)

    if tag_id:
        clauses.append(
            "AND EXISTS (SELECT 1 FROM media_tags WHERE media_tags.media_id = media_items.id "
            "AND media_tags.tag_id = ?)"
        )
        parameters.append(tag_id)

    if place:
        # "Place" is composed from the folder path and description because this
        # library has no geocoded place names: coordinates are stored, but
        # reverse geocoding was deliberately rejected (it would send photo
        # locations to a third party). Matching the text the user actually
        # typed is honest; guessing a city from lat/lon would not be.
        clauses.append(
            "AND (COALESCE(folder_path, '') LIKE ? OR COALESCE(description, '') LIKE ?)"
        )
        like = f"%{place}%"
        parameters.extend([like, like])

    if favorite is True:
        clauses.append("AND is_favorite = 1")
    elif favorite is False:
        clauses.append("AND is_favorite = 0")

    return clauses, parameters


def camera_options(client_id: str) -> list[dict[str, Any]]:
    """Distinct cameras actually present, with counts, for the filter menu.

    Built from the library rather than a fixed list so the dropdown can never
    offer a camera the user does not own.
    """
    with closing(open_db()) as connection:
        rows = connection.execute(
            """
            SELECT
                COALESCE(NULLIF(camera_model, ''), NULLIF(camera_make, '')) AS label,
                camera_make, camera_model, COUNT(*) AS total
            FROM media_items
            WHERE client_id = ? AND COALESCE(trashed_at, '') = ''
              AND (COALESCE(camera_model, '') <> '' OR COALESCE(camera_make, '') <> '')
            GROUP BY label
            ORDER BY total DESC, label
            """,
            (client_id,),
        ).fetchall()
    return [
        {"label": row["label"], "make": row["camera_make"], "model": row["camera_model"], "count": row["total"]}
        for row in rows
    ]


def list_media_page(
    client_id: str,
    view: str = "library",
    query: str | None = None,
    album_id: str | None = None,
    cursor: str | None = None,
    limit: int = DEFAULT_PAGE_SIZE,
    date_from: str | None = None,
    date_to: str | None = None,
    media_type: str | None = None,
    has_faces: bool | None = None,
    has_location: bool | None = None,
    sort: str = "newest",
    camera: str | None = None,
    person_id: str | None = None,
    tag_id: str | None = None,
    place: str | None = None,
    favorite: bool | None = None,
) -> tuple[list[sqlite3.Row], str | None]:
    """One page of media, newest first, using a keyset cursor.

    Keyset rather than OFFSET because new photos arrive between polls: an
    OFFSET would skip or repeat rows as the list shifts, while
    (capture_time, id) stays stable. `id` is the tiebreaker for rows that
    share a capture_time, which is common for bulk imports.
    """
    limit = max(1, min(limit, MAX_PAGE_SIZE))

    state_filter = {
        "library": "trashed_at IS NULL AND is_archived = 0",
        "favorites": "trashed_at IS NULL AND is_favorite = 1",
        "archive": "trashed_at IS NULL AND is_archived = 1",
        "trash": "trashed_at IS NOT NULL",
        "all": "1 = 1",
    }.get(view, "trashed_at IS NULL AND is_archived = 0")

    parameters: list[Any] = [client_id]
    album_filter = ""
    if album_id:
        album_filter = "AND id IN (SELECT media_id FROM album_media WHERE album_id = ?)"
        parameters.append(album_id)

    search_filter = ""
    if query and query.strip():
        search_filter = (
            "AND (LOWER(original_name) LIKE ? OR LOWER(description) LIKE ? "
            "OR LOWER(COALESCE(folder_path, '')) LIKE ?)"
        )
        term = f"%{query.strip().lower()}%"
        parameters.extend([term, term, term])

    filter_fragments, filter_parameters = build_media_filters(
        date_from=date_from,
        date_to=date_to,
        media_type=media_type,
        has_faces=has_faces,
        has_location=has_location,
        camera=camera,
        person_id=person_id,
        tag_id=tag_id,
        place=place,
        favorite=favorite,
    )
    extra_filter = "".join(filter_fragments)
    parameters.extend(filter_parameters)

    # Sorting flips the comparison direction, so the keyset predicate must flip
    # with it, otherwise "load more" would re-serve rows already on screen.
    ascending = sort == "oldest"
    order = "ASC" if ascending else "DESC"
    cursor_filter = ""
    if cursor:
        cursor_time, cursor_id = decode_cursor(cursor)
        operator = ">" if ascending else "<"
        cursor_filter = (
            f"AND (capture_time {operator} ? OR (capture_time = ? AND id {operator} ?))"
        )
        parameters.extend([cursor_time, cursor_time, cursor_id])

    # Fetch one extra row to learn whether another page exists without a
    # second COUNT query.
    parameters.append(limit + 1)

    with closing(open_db()) as connection:
        rows = list(connection.execute(
            f"SELECT * FROM media_items WHERE client_id = ? AND {state_filter} "
            f"{album_filter} {search_filter} {extra_filter} {cursor_filter} "
            f"ORDER BY capture_time {order}, id {order} LIMIT ?",
            parameters,
        ).fetchall())

    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        next_cursor = encode_cursor(last["capture_time"], last["id"])
    else:
        next_cursor = None
    return rows, next_cursor


def update_media(
    media_id: str,
    client_id: str,
    *,
    is_favorite: bool | None = None,
    is_archived: bool | None = None,
    trashed: bool | None = None,
    description: str | None = None,
    capture_time: str | None = None,
    folder_path: str | None = None,
) -> sqlite3.Row | None:
    changes: list[str] = []
    parameters: list[Any] = []
    if is_favorite is not None:
        changes.append("is_favorite = ?")
        parameters.append(int(is_favorite))
    if is_archived is not None:
        changes.append("is_archived = ?")
        parameters.append(int(is_archived))
    if trashed is not None:
        changes.append("trashed_at = ?")
        parameters.append(utc_now() if trashed else None)
    if description is not None:
        changes.append("description = ?")
        parameters.append(description.strip()[:2000])
    if capture_time is not None:
        changes.append("capture_time = ?")
        parameters.append(capture_time)
    if folder_path is not None:
        changes.append("folder_path = ?")
        parameters.append(folder_path.strip()[:500] or None)
    if not changes:
        return get_media(media_id, client_id)
    changes.append("updated_at = ?")
    parameters.extend([utc_now(), media_id, client_id])
    with closing(open_db()) as connection:
        result = connection.execute(
            f"UPDATE media_items SET {', '.join(changes)} WHERE id = ? AND client_id = ?",
            parameters,
        )
        connection.commit()
        if result.rowcount == 0:
            return None
        row = connection.execute(
            "SELECT * FROM media_items WHERE id = ? AND client_id = ?",
            (media_id, client_id),
        ).fetchone()
    mark_library_changed(client_id)
    return row


def delete_media(media_id: str, client_id: str) -> str | None:
    with closing(open_db()) as connection:
        row = connection.execute(
            "SELECT local_path FROM media_items WHERE id = ? AND client_id = ?",
            (media_id, client_id),
        ).fetchone()
        if not row:
            return None
        connection.execute("DELETE FROM media_items WHERE id = ? AND client_id = ?", (media_id, client_id))
        connection.commit()
    mark_library_changed(client_id)
    return str(row["local_path"])


def list_albums(client_id: str) -> list[sqlite3.Row]:
    """Albums with a count and a cover.

    The cover is the newest item's id rather than a stored column, so it stays
    correct when items are added or removed and needs no extra migration.
    """
    with closing(open_db()) as connection:
        return list(connection.execute(
            """
            SELECT albums.*,
                   COUNT(album_media.media_id) AS media_count,
                   (
                       SELECT album_media.media_id
                       FROM album_media
                       JOIN media_items ON media_items.id = album_media.media_id
                       WHERE album_media.album_id = albums.id
                       ORDER BY media_items.capture_time DESC, media_items.created_at DESC
                       LIMIT 1
                   ) AS cover_media_id
            FROM albums LEFT JOIN album_media ON album_media.album_id = albums.id
            WHERE albums.client_id = ?
            GROUP BY albums.id ORDER BY albums.created_at DESC
            """,
            (client_id,),
        ).fetchall())


def create_album(client_id: str, name: str, description: str = "") -> sqlite3.Row:
    album_id = str(uuid4())
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            "INSERT INTO albums (id, client_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (album_id, client_id, name.strip()[:200], description.strip()[:2000], now, now),
        )
        row = connection.execute("SELECT *, 0 AS media_count FROM albums WHERE id = ?", (album_id,)).fetchone()
        connection.commit()
    mark_library_changed(client_id)
    return row


def delete_album(album_id: str, client_id: str) -> bool:
    with closing(open_db()) as connection:
        result = connection.execute("DELETE FROM albums WHERE id = ? AND client_id = ?", (album_id, client_id))
        connection.commit()
        return result.rowcount > 0


def add_media_to_album(album_id: str, media_ids: list[str], client_id: str) -> int:
    now = utc_now()
    with closing(open_db()) as connection:
        album = connection.execute("SELECT id FROM albums WHERE id = ? AND client_id = ?", (album_id, client_id)).fetchone()
        if not album:
            return -1
        valid_ids = [row["id"] for row in connection.execute(
            f"SELECT id FROM media_items WHERE client_id = ? AND id IN ({','.join('?' for _ in media_ids)})",
            [client_id, *media_ids],
        ).fetchall()] if media_ids else []
        for media_id in valid_ids:
            connection.execute(
                "INSERT OR IGNORE INTO album_media (album_id, media_id, added_at) VALUES (?, ?, ?)",
                (album_id, media_id, now),
            )
        connection.commit()
    mark_library_changed(client_id)
    return len(valid_ids)


def remove_media_from_album(album_id: str, media_ids: list[str], client_id: str) -> int:
    """Unlink items from an album without touching the media itself.

    Returns -1 for a missing album so the route can 404; an empty result is a
    legitimate "nothing was linked", not an error.
    """
    with closing(open_db()) as connection:
        album = connection.execute(
            "SELECT id FROM albums WHERE id = ? AND client_id = ?", (album_id, client_id)
        ).fetchone()
        if not album:
            return -1
        if not media_ids:
            return 0
        placeholders = ",".join("?" for _ in media_ids)
        cursor = connection.execute(
            f"DELETE FROM album_media WHERE album_id = ? AND media_id IN ({placeholders})",
            [album_id, *media_ids],
        )
        removed = cursor.rowcount
        connection.commit()
    mark_library_changed(client_id)
    return max(0, removed)


def update_album(album_id: str, client_id: str, name: str | None = None, description: str | None = None) -> sqlite3.Row | None:
    """Rename or re-describe an album. Absent fields are left alone."""
    with closing(open_db()) as connection:
        existing = connection.execute(
            "SELECT id FROM albums WHERE id = ? AND client_id = ?", (album_id, client_id)
        ).fetchone()
        if not existing:
            return None
        sets: list[str] = []
        params: list = []
        if name is not None:
            cleaned = name.strip()
            if not cleaned:
                raise ValueError("An album needs a name")
            sets.append("name = ?")
            params.append(cleaned[:200])
        if description is not None:
            sets.append("description = ?")
            params.append(description.strip()[:2000])
        if sets:
            sets.append("updated_at = ?")
            params.append(utc_now())
            params.extend([album_id, client_id])
            connection.execute(
                f"UPDATE albums SET {', '.join(sets)} WHERE id = ? AND client_id = ?", params
            )
            connection.commit()
        row = connection.execute(
            """
            SELECT albums.*, COUNT(album_media.media_id) AS media_count
            FROM albums LEFT JOIN album_media ON album_media.album_id = albums.id
            WHERE albums.id = ? GROUP BY albums.id
            """,
            (album_id,),
        ).fetchone()
    mark_library_changed(client_id)
    return row


def list_tags(client_id: str) -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return list(connection.execute(
            "SELECT tags.*, COUNT(media_tags.media_id) AS media_count FROM tags LEFT JOIN media_tags ON media_tags.tag_id = tags.id WHERE tags.client_id = ? GROUP BY tags.id ORDER BY tags.name COLLATE NOCASE",
            (client_id,),
        ).fetchall())


def create_tag(client_id: str, name: str) -> sqlite3.Row:
    tag_id = str(uuid4())
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            "INSERT INTO tags (id, client_id, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(client_id, name) DO NOTHING",
            (tag_id, client_id, name.strip()[:100], now),
        )
        row = connection.execute("SELECT tags.*, 0 AS media_count FROM tags WHERE client_id = ? AND name = ? COLLATE NOCASE", (client_id, name.strip()[:100])).fetchone()
        connection.commit()
    mark_library_changed(client_id)
    return row


def add_tag_to_media(tag_id: str, media_ids: list[str], client_id: str) -> int:
    now = utc_now()
    with closing(open_db()) as connection:
        tag = connection.execute("SELECT id FROM tags WHERE id = ? AND client_id = ?", (tag_id, client_id)).fetchone()
        if not tag or not media_ids:
            return -1 if not tag else 0
        valid_ids = [row["id"] for row in connection.execute(
            f"SELECT id FROM media_items WHERE client_id = ? AND id IN ({','.join('?' for _ in media_ids)})",
            [client_id, *media_ids],
        ).fetchall()]
        for media_id in valid_ids:
            connection.execute("INSERT OR IGNORE INTO media_tags (media_id, tag_id, added_at) VALUES (?, ?, ?)", (media_id, tag_id, now))
        connection.commit()
        return len(valid_ids)


def queued_media_ids(client_id: str | None = None) -> list[str]:
    with closing(open_db()) as connection:
        if client_id:
            rows = connection.execute(
                """
                SELECT media_id FROM upload_jobs
                JOIN media_items ON media_items.id = upload_jobs.media_id
                WHERE media_items.client_id = ?
                  AND upload_jobs.status IN ('queued', 'waiting_for_telegram')
                ORDER BY upload_jobs.created_at
                """,
                (client_id,),
            ).fetchall()
        else:
            rows = connection.execute(
                """
                SELECT upload_jobs.media_id FROM upload_jobs
                JOIN media_items ON media_items.id = upload_jobs.media_id
                WHERE upload_jobs.status IN ('queued', 'waiting_for_telegram')
                ORDER BY upload_jobs.created_at
                """
            ).fetchall()
        return [str(row[0]) for row in rows]


def reset_interrupted_jobs() -> list[str]:
    with closing(open_db()) as connection:
        now = utc_now()
        connection.execute(
            "UPDATE media_items SET upload_status = 'queued', updated_at = ? WHERE upload_status = 'uploading'",
            (now,),
        )
        connection.execute(
            "UPDATE upload_jobs SET status = 'queued', updated_at = ? WHERE status = 'uploading'",
            (now,),
        )
        connection.commit()
    return queued_media_ids()


def mark_uploading(media_id: str) -> None:
    with closing(open_db()) as connection:
        now = utc_now()
        connection.execute(
            "UPDATE media_items SET upload_status = 'uploading', updated_at = ? WHERE id = ?",
            (now, media_id),
        )
        connection.execute(
            "UPDATE upload_jobs SET status = 'uploading', attempts = attempts + 1, updated_at = ? WHERE media_id = ?",
            (now, media_id),
        )
        connection.commit()


def mark_waiting_for_telegram(media_id: str) -> None:
    with closing(open_db()) as connection:
        now = utc_now()
        connection.execute(
            "UPDATE media_items SET upload_status = 'waiting_for_telegram', updated_at = ? WHERE id = ?",
            (now, media_id),
        )
        connection.execute(
            "UPDATE upload_jobs SET status = 'waiting_for_telegram', updated_at = ? WHERE media_id = ?",
            (now, media_id),
        )
        connection.commit()


def mark_uploaded(media_id: str, telegram_message_id: int) -> None:
    with closing(open_db()) as connection:
        now = utc_now()
        connection.execute(
            """
            UPDATE media_items
            SET upload_status = 'uploaded', telegram_message_id = ?, upload_error = NULL, updated_at = ?
            WHERE id = ?
            """,
            (telegram_message_id, now, media_id),
        )
        connection.execute(
            "UPDATE upload_jobs SET status = 'uploaded', last_error = NULL, updated_at = ? WHERE media_id = ?",
            (now, media_id),
        )
        owner = connection.execute(
            "SELECT client_id FROM media_items WHERE id = ?", (media_id,)
        ).fetchone()
        connection.commit()
    # Metadata now differs from the last Telegram snapshot.
    if owner:
        mark_library_changed(owner["client_id"])


def mark_failed(media_id: str, error: str) -> None:
    safe_error = error[:500]
    with closing(open_db()) as connection:
        now = utc_now()
        connection.execute(
            "UPDATE media_items SET upload_status = 'failed', upload_error = ?, updated_at = ? WHERE id = ?",
            (safe_error, now, media_id),
        )
        connection.execute(
            "UPDATE upload_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE media_id = ?",
            (safe_error, now, media_id),
        )
        connection.commit()


def retry_media(media_id: str, client_id: str) -> bool:
    with closing(open_db()) as connection:
        now = utc_now()
        result = connection.execute(
            "UPDATE media_items SET upload_status = 'queued', upload_error = NULL, updated_at = ? WHERE id = ? AND client_id = ?",
            (now, media_id, client_id),
        )
        if result.rowcount == 0:
            return False
        connection.execute(
            "UPDATE upload_jobs SET status = 'queued', last_error = NULL, updated_at = ? WHERE media_id = ?",
            (now, media_id),
        )
        connection.commit()
        return True


def row_to_media(row: sqlite3.Row, api_prefix: str = "/api") -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["original_name"],
        "type": row["media_type"],
        "mime_type": row["mime_type"],
        "size": row["size_bytes"],
        "captured_at": row["capture_time"],
        "source_label": row["capture_source"],
        "width": row["width"],
        "height": row["height"],
        "duration": row["duration"],
        "checksum": row["checksum"],
        "is_favorite": bool(row["is_favorite"]),
        "is_archived": bool(row["is_archived"]),
        "is_trashed": row["trashed_at"] is not None,
        "description": row["description"],
        "folder_path": row["folder_path"],
        "latitude": row["latitude"],
        "longitude": row["longitude"],
        # Grid/viewer image: a cached 400px WebP, not the full original.
        "preview_url": f"{api_prefix}/media/{row['id']}/thumbnail",
        # Full-size original, used only by explicit download actions.
        "content_url": f"{api_prefix}/media/{row['id']}/content",
        "telegram_url": f"{api_prefix}/media/{row['id']}/telegram-content" if row["telegram_message_id"] else None,
        "telegram_download_url": f"{api_prefix}/media/{row['id']}/telegram-download" if row["telegram_message_id"] else None,
        "upload_status": row["upload_status"],
        "upload_error": row["upload_error"],
        "telegram_message_id": row["telegram_message_id"],
        # "missing" means the local copy is gone but metadata is intact; the
        # UI shows a placeholder instead of a broken image.
        "file_state": row["file_state"],
        # pending | running | ready | failed — "ready" means preview_url is a
        # real cached thumbnail rather than the full original.
        "thumb_state": row["thumb_state"],
        # pending | ready | failed — "ready" means proxy_url is a small,
        # seek-friendly re-encode instead of the full Telegram download.
        "proxy_state": row["proxy_state"],
        "proxy_url": f"{api_prefix}/media/{row['id']}/proxy" if row["proxy_state"] == "ready" else None,
        # None until an integrity check has run for this asset.
        "integrity_state": row["integrity_state"],
        "integrity_checked_at": row["integrity_checked_at"],
    }


# ---------------------------------------------------------------------------
# Face recognition
# ---------------------------------------------------------------------------

def enqueue_face_job(media_id: str, client_id: str) -> None:
    """Queue a photo for face analysis. Safe to call repeatedly."""
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            """
            INSERT INTO face_jobs (id, media_id, status, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
                status = 'queued',
                last_error = NULL,
                updated_at = excluded.updated_at
            """,
            (str(uuid4()), media_id, now, now),
        )
        connection.commit()


def enqueue_all_photos(client_id: str) -> int:
    """Queue every photo that has no faces recorded yet."""
    now = utc_now()
    with closing(open_db()) as connection:
        rows = connection.execute(
            """
            SELECT id FROM media_items
            WHERE client_id = ?
              AND media_type = 'photo'
              AND trashed_at IS NULL
              AND id NOT IN (SELECT media_id FROM faces)
              AND id NOT IN (SELECT media_id FROM face_jobs WHERE status = 'queued')
            """,
            (client_id,),
        ).fetchall()
        for row in rows:
            connection.execute(
                """
                INSERT INTO face_jobs (id, media_id, status, created_at, updated_at)
                VALUES (?, ?, 'queued', ?, ?)
                ON CONFLICT(media_id) DO UPDATE SET
                    status = 'queued', last_error = NULL, updated_at = excluded.updated_at
                """,
                (str(uuid4()), row["id"], now, now),
            )
        connection.commit()
        return len(rows)


def next_face_job() -> sqlite3.Row | None:
    with closing(open_db()) as connection:
        return connection.execute(
            """
            SELECT face_jobs.*, media_items.local_path, media_items.media_type,
                   media_items.client_id, media_items.original_name
            FROM face_jobs
            JOIN media_items ON media_items.id = face_jobs.media_id
            WHERE face_jobs.status = 'queued'
            ORDER BY face_jobs.created_at
            LIMIT 1
            """
        ).fetchone()


def mark_face_job_running(media_id: str) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE face_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE media_id = ?",
            (utc_now(), media_id),
        )
        connection.commit()


def mark_face_job_done(media_id: str) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE face_jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE media_id = ?",
            (utc_now(), media_id),
        )
        connection.commit()


def mark_face_job_failed(media_id: str, error: str) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE face_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE media_id = ?",
            (error[:300], utc_now(), media_id),
        )
        connection.commit()


def reset_interrupted_face_jobs() -> None:
    """Anything left 'running' after a crash goes back to the queue."""
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE face_jobs SET status = 'queued', updated_at = ? WHERE status = 'running'",
            (utc_now(),),
        )
        connection.commit()


def replace_faces_for_media(client_id: str, media_id: str, faces: list[dict[str, Any]]) -> None:
    """Replace all detections for one asset. Embeddings stored as float32 BLOBs."""
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute("DELETE FROM faces WHERE media_id = ?", (media_id,))
        for face in faces:
            connection.execute(
                """
                INSERT INTO faces
                    (id, client_id, media_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h,
                     det_score, embedding, embedding_dim, created_at)
                VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid4()), client_id, media_id,
                    face["bbox_x"], face["bbox_y"], face["bbox_w"], face["bbox_h"],
                    face["det_score"], face["embedding"], face["embedding_dim"], now,
                ),
            )
        connection.commit()


def list_unassigned_faces(client_id: str) -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return list(connection.execute(
            "SELECT * FROM faces WHERE client_id = ? AND person_id IS NULL ORDER BY created_at",
            (client_id,),
        ).fetchall())


def list_people(client_id: str) -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return list(connection.execute(
            "SELECT * FROM people WHERE client_id = ? ORDER BY face_count DESC, created_at",
            (client_id,),
        ).fetchall())


def create_person(client_id: str, name: str | None, cover_face_id: str | None) -> sqlite3.Row:
    person_id = str(uuid4())
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            "INSERT INTO people (id, client_id, name, cover_face_id, face_count, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, 0, ?, ?)",
            (person_id, client_id, name, cover_face_id, now, now),
        )
        connection.commit()
        return connection.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()


def assign_face_to_person(face_id: str, person_id: str) -> None:
    with closing(open_db()) as connection:
        connection.execute("UPDATE faces SET person_id = ? WHERE id = ?", (person_id, face_id))
        connection.execute(
            """
            UPDATE people SET face_count =
                (SELECT COUNT(*) FROM faces WHERE person_id = people.id), updated_at = ?
            WHERE id = ?
            """,
            (utc_now(), person_id),
        )
        connection.commit()


def set_person_name(person_id: str, client_id: str, name: str | None) -> sqlite3.Row | None:
    with closing(open_db()) as connection:
        result = connection.execute(
            "UPDATE people SET name = ?, updated_at = ? WHERE id = ? AND client_id = ?",
            (name, utc_now(), person_id, client_id),
        )
        connection.commit()
        if result.rowcount == 0:
            return None
        return connection.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()


def merge_people(source_id: str, target_id: str, client_id: str) -> int:
    """Move every face from source into target, then delete source."""
    with closing(open_db()) as connection:
        valid = connection.execute(
            "SELECT id FROM people WHERE id IN (?, ?) AND client_id = ?", (source_id, target_id, client_id)
        ).fetchall()
        if len(valid) != 2:
            return 0
        moved = connection.execute(
            "UPDATE faces SET person_id = ? WHERE person_id = ?", (target_id, source_id)
        ).rowcount
        connection.execute(
            "UPDATE people SET face_count = (SELECT COUNT(*) FROM faces WHERE person_id = ?), updated_at = ? WHERE id = ?",
            (target_id, utc_now(), target_id),
        )
        connection.execute("DELETE FROM people WHERE id = ?", (source_id,))
        connection.commit()
        return int(moved)


def face_job_stats(client_id: str) -> dict[str, int]:
    with closing(open_db()) as connection:
        rows = connection.execute(
            """
            SELECT face_jobs.status AS status, COUNT(*) AS total
            FROM face_jobs JOIN media_items ON media_items.id = face_jobs.media_id
            WHERE media_items.client_id = ?
            GROUP BY face_jobs.status
            """,
            (client_id,),
        ).fetchall()
        counts = {row["status"]: row["total"] for row in rows}
        faces = connection.execute(
            "SELECT COUNT(*) FROM faces WHERE client_id = ?", (client_id,)
        ).fetchone()[0]
        people = connection.execute(
            "SELECT COUNT(*) FROM people WHERE client_id = ?", (client_id,)
        ).fetchone()[0]
    return {
        "queued": counts.get("queued", 0),
        "running": counts.get("running", 0),
        "done": counts.get("done", 0),
        "failed": counts.get("failed", 0),
        "faces": faces,
        "people": people,
    }


def list_media_by_person(client_id: str, person_id: str) -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return list(connection.execute(
            """
            SELECT DISTINCT media_items.* FROM media_items
            JOIN faces ON faces.media_id = media_items.id
            WHERE media_items.client_id = ? AND faces.person_id = ?
              AND media_items.trashed_at IS NULL
            ORDER BY media_items.capture_time DESC
            """,
            (client_id, person_id),
        ).fetchall())


def row_to_face(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "media_id": row["media_id"],
        "person_id": row["person_id"],
        "box": {
            "x": row["bbox_x"], "y": row["bbox_y"],
            "w": row["bbox_w"], "h": row["bbox_h"],
        },
        "det_score": row["det_score"],
    }


# ---------------------------------------------------------------------------
# Local file paths
#
# Paths are stored RELATIVE to DATA_DIR. Storing an absolute path means the
# library breaks the moment the project folder is renamed or moved -- which is
# exactly what happened to rows created before this change (they point at the
# old "telegram-gallery" folder).
# ---------------------------------------------------------------------------

def to_relative(path: str | Path) -> str:
    """Store a path relative to DATA_DIR when it lives inside it."""
    candidate = Path(path)
    try:
        return str(candidate.resolve().relative_to(DATA_DIR.resolve()))
    except (ValueError, OSError):
        # Outside DATA_DIR: keep only the filename so the row stays portable.
        return candidate.name


def resolve_local_path(stored: str | None) -> Path:
    """Turn a stored path into an absolute path, tolerating legacy rows."""
    if not stored:
        return UPLOAD_DIR / "__missing__"
    candidate = Path(stored)
    if candidate.is_absolute():
        return candidate
    return DATA_DIR / candidate


def local_file_exists(stored: str | None) -> bool:
    return resolve_local_path(stored).is_file()


def list_rows_needing_path_check() -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return connection.execute(
            "SELECT id, client_id, local_path, original_name, media_type, "
            "file_state, telegram_message_id FROM media_items"
        ).fetchall()


def update_local_path(media_id: str, stored_path: str, file_state: str = "present") -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE media_items SET local_path = ?, file_state = ? WHERE id = ?",
            (stored_path, file_state, media_id),
        )
        connection.commit()


def set_file_state(media_id: str, file_state: str) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE media_items SET file_state = ? WHERE id = ?", (file_state, media_id)
        )
        connection.commit()


def find_row_by_local_filename(filename: str) -> sqlite3.Row | None:
    """Locate a row by the tail of its stored path (used to rebase paths)."""
    with closing(open_db()) as connection:
        return connection.execute(
            "SELECT id, client_id, local_path FROM media_items "
            "WHERE local_path LIKE ? OR local_path = ? LIMIT 1",
            (f"%{filename}", filename),
        ).fetchone()


def rebase_stale_paths() -> dict[str, int]:
    """Rewrite absolute paths that point outside DATA_DIR.

    A legacy row may still be valid if the file exists at the *old* absolute
    location, so we only rebase when the current location is unreadable.
    """
    stats = {"rebased": 0, "missing": 0}
    for row in list_rows_needing_path_check():
        stored = row["local_path"]
        if local_file_exists(stored):
            continue

        candidate = resolve_local_path(stored)
        # Try the same filename inside UPLOAD_DIR before giving up.
        relocated = UPLOAD_DIR / candidate.name
        if relocated.is_file():
            update_local_path(row["id"], to_relative(relocated), "present")
            stats["rebased"] += 1
        else:
            set_file_state(row["id"], "missing")
            stats["missing"] += 1
    return stats


def reconcile_local_files(telegram_lookup=None) -> dict[str, int]:
    """Startup reconciliation: make every row's file state truthful.

    Order of attempts per row:
      1. Does the stored path resolve to a real file?  -> present
      2. Is that filename sitting in UPLOAD_DIR?       -> rebase, present
      3. Is there a copy in the Telegram cache?        -> repoint, present
      4. Otherwise                                     -> missing
    """
    stats = {"ok": 0, "rebased": 0, "restored": 0, "missing": 0}
    for row in list_rows_needing_path_check():
        stored = row["local_path"]

        if local_file_exists(stored):
            # The file is readable, but an absolute path is still fragile:
            # normalise it to a relative one so a future move cannot break it.
            candidate = resolve_local_path(stored)
            try:
                candidate.resolve().relative_to(DATA_DIR.resolve())
            except ValueError:
                stats["ok"] += 1          # genuinely outside DATA_DIR; leave it
            else:
                if Path(stored).is_absolute():
                    update_local_path(row["id"], to_relative(candidate), "present")
                stats["ok"] += 1
            continue

        candidate = resolve_local_path(stored)
        relocated = UPLOAD_DIR / candidate.name
        if relocated.is_file():
            update_local_path(row["id"], to_relative(relocated), "present")
            stats["rebased"] += 1
            continue

        cached = CACHE_DIR / candidate.name
        if cached.is_file():
            update_local_path(row["id"], to_relative(cached), "present")
            stats["restored"] += 1
            continue

        stats["missing"] += 1
        set_file_state(row["id"], "missing")

    return stats


# ---------------------------------------------------------------------------
# Thumbnails
#
# Sizes are fixed: the grid never renders a tile larger than a few hundred
# pixels, so generating anything bigger wastes disk and time. WebP because it
# is ~30% smaller than JPEG at these sizes and universally supported.
# ---------------------------------------------------------------------------

def thumb_paths(media_id: str) -> tuple[Path, Path]:
    return THUMB_DIR / f"{media_id}_thumb.webp", THUMB_DIR / f"{media_id}_micro.webp"


def thumbnails_exist(media_id: str) -> bool:
    thumb, micro = thumb_paths(media_id)
    return thumb.is_file() and micro.is_file()


def enqueue_thumbnail_job(media_id: str) -> None:
    """Queue thumbnail generation. Safe to call repeatedly."""
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            """
            INSERT INTO thumbnail_jobs (id, media_id, status, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
                status = 'queued',
                last_error = NULL,
                updated_at = excluded.updated_at
            """,
            (str(uuid4()), media_id, now, now),
        )
        connection.execute(
            "UPDATE media_items SET thumb_state = 'pending' WHERE id = ?", (media_id,)
        )
        connection.commit()


def enqueue_all_thumbnails(client_id: str) -> int:
    """Queue every media row that has no thumbnail yet."""
    with closing(open_db()) as connection:
        rows = connection.execute(
            "SELECT id FROM media_items WHERE client_id = ? AND thumb_state != 'ready'",
            (client_id,),
        ).fetchall()
    for row in rows:
        enqueue_thumbnail_job(row["id"])
    return len(rows)


def next_thumbnail_job() -> sqlite3.Row | None:
    with closing(open_db()) as connection:
        return connection.execute(
            """
            SELECT thumbnail_jobs.media_id, media_items.local_path, media_items.media_type
            FROM thumbnail_jobs
            JOIN media_items ON media_items.id = thumbnail_jobs.media_id
            WHERE thumbnail_jobs.status = 'queued'
            ORDER BY thumbnail_jobs.created_at
            LIMIT 1
            """
        ).fetchone()


def mark_thumbnail_running(media_id: str) -> None:
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE thumbnail_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? "
            "WHERE media_id = ?",
            (now, media_id),
        )
        connection.execute(
            "UPDATE media_items SET thumb_state = 'running' WHERE id = ?", (media_id,)
        )
        connection.commit()


def mark_thumbnail_skipped(media_id: str, reason: str) -> None:
    """Finish a job deliberately without a thumbnail.

    Distinct from 'failed' so a re-queue pass does not keep re-attempting an
    original that is too large to fetch. The UI shows a placeholder tile and
    playback still works, because the viewer streams from Telegram directly.
    """
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE thumbnail_jobs SET status = 'skipped', last_error = ?, updated_at = ? "
            "WHERE media_id = ?",
            (reason, utc_now(), media_id),
        )
        connection.execute(
            "UPDATE media_items SET thumb_state = 'skipped' WHERE id = ?", (media_id,)
        )
        connection.commit()


def mark_thumbnail_done(media_id: str) -> None:
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE thumbnail_jobs SET status = 'done', last_error = NULL, updated_at = ? "
            "WHERE media_id = ?",
            (now, media_id),
        )
        connection.execute(
            "UPDATE media_items SET thumb_state = 'ready' WHERE id = ?", (media_id,)
        )
        connection.commit()


def mark_thumbnail_failed(media_id: str, reason: str) -> None:
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE thumbnail_jobs SET status = 'failed', last_error = ?, updated_at = ? "
            "WHERE media_id = ?",
            (reason[:500], now, media_id),
        )
        connection.execute(
            "UPDATE media_items SET thumb_state = 'failed' WHERE id = ?", (media_id,)
        )
        connection.commit()


def reset_interrupted_thumbnail_jobs() -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE thumbnail_jobs SET status = 'queued' WHERE status = 'running'"
        )
        connection.execute(
            "UPDATE media_items SET thumb_state = 'pending' WHERE thumb_state = 'running'"
        )
        connection.commit()


def thumbnail_job_stats(client_id: str) -> dict[str, int]:
    with closing(open_db()) as connection:
        rows = connection.execute(
            "SELECT thumb_state, COUNT(*) AS n FROM media_items WHERE client_id = ? "
            "GROUP BY thumb_state",
            (client_id,),
        ).fetchall()
    stats = {"pending": 0, "running": 0, "ready": 0, "failed": 0}
    for row in rows:
        stats[row["thumb_state"]] = row["n"]
    return stats


# ---------------------------------------------------------------------------
# Integrity
#
# Immich verifies a local file still matches its checksum. There is no local
# file to checksum here -- the original lives in Telegram -- so the equivalent
# question is "does the Telegram message still exist?". That is a metadata
# lookup, not a download, so it is cheap enough to run over a whole library.
#
# This deliberately proves EXISTENCE, not byte-equality. A byte comparison
# would mean re-downloading every original, which defeats the point of
# keeping Telegram as a cold store.
# ---------------------------------------------------------------------------

def list_media_for_integrity(client_id: str) -> list[sqlite3.Row]:
    """Rows that claim to be in Telegram, newest first."""
    with closing(open_db()) as connection:
        return connection.execute(
            "SELECT id, original_name, telegram_message_id, upload_status "
            "FROM media_items WHERE client_id = ? AND telegram_message_id IS NOT NULL "
            "ORDER BY capture_time DESC",
            (client_id,),
        ).fetchall()


def set_integrity_state(media_id: str, state: str) -> None:
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE media_items SET integrity_state = ?, integrity_checked_at = ? WHERE id = ?",
            (state, now, media_id),
        )
        connection.commit()


def integrity_summary(client_id: str) -> dict[str, Any]:
    with closing(open_db()) as connection:
        rows = connection.execute(
            "SELECT integrity_state, COUNT(*) AS n FROM media_items "
            "WHERE client_id = ? AND telegram_message_id IS NOT NULL "
            "GROUP BY integrity_state",
            (client_id,),
        ).fetchall()
        last = connection.execute(
            "SELECT MAX(integrity_checked_at) AS t FROM media_items WHERE client_id = ?",
            (client_id,),
        ).fetchone()
    summary: dict[str, Any] = {"ok": 0, "missing": 0, "unchecked": 0, "last_checked_at": last["t"]}
    for row in rows:
        key = row["integrity_state"] or "unchecked"
        summary[key] = row["n"]
    return summary


def largest_media(client_id: str, limit: int = 20, min_bytes: int = 5 * 1024 * 1024) -> dict[str, Any]:
    """Biggest files, for the storage section of Utilities.

    Sorted by size rather than capture time because the question this answers is
    "what is using my disk", not "what did I shoot last".
    """
    with closing(open_db()) as connection:
        rows = list(connection.execute(
            "SELECT * FROM media_items WHERE client_id = ? AND COALESCE(trashed_at, '') = '' "
            "AND size_bytes >= ? ORDER BY size_bytes DESC LIMIT ?",
            (client_id, min_bytes, limit),
        ).fetchall())
        total = connection.execute(
            "SELECT COALESCE(SUM(size_bytes), 0) AS t FROM media_items "
            "WHERE client_id = ? AND COALESCE(trashed_at, '') = ''",
            (client_id,),
        ).fetchone()["t"]
    return {"items": rows, "total_bytes": total, "min_bytes": min_bytes}


def location_gaps(client_id: str) -> dict[str, Any]:
    """How many photos are missing GPS, so the gap is visible rather than silent.

    Reported, never auto-filled: inventing coordinates would put photos on the
    map in places they were not taken.
    """
    with closing(open_db()) as connection:
        row = connection.execute(
            """
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN latitude IS NULL OR longitude IS NULL THEN 1 ELSE 0 END) AS missing,
                SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END) AS located
            FROM media_items
            WHERE client_id = ? AND COALESCE(trashed_at, '') = '' AND media_type = 'photo'
            """,
            (client_id,),
        ).fetchone()
    total = row["total"] or 0
    located = row["located"] or 0
    return {
        "total": total,
        "located": located,
        "missing": row["missing"] or 0,
        "percent_located": round(100 * located / total, 1) if total else 0.0,
    }


def list_broken_media(client_id: str) -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return list(connection.execute(
            "SELECT * FROM media_items WHERE client_id = ? AND integrity_state = 'missing' "
            "ORDER BY capture_time DESC",
            (client_id,),
        ).fetchall())


# ---------------------------------------------------------------------------
# Restore and metadata backup
#
# Everything that lives ONLY in SQLite is lost if backend/data is deleted:
# albums, tags, favourites, descriptions, people names. The originals survive
# in Telegram, but Telegram knows nothing about them. Two mechanisms close
# that gap:
#
#   1. Metadata backup -- serialise the local index to JSON and upload it to
#      Saved Messages. Lossless recovery.
#   2. Restore scan -- read Saved Messages back. Prefers a metadata backup;
#      falls back to rebuilding from upload captions, which recovers the
#      photos but not albums/tags/favourites.
# ---------------------------------------------------------------------------

RESTORE_CAPTION_MARKER = "InfinityVault backup"


def export_metadata(client_id: str) -> dict[str, Any]:
    """A portable snapshot of everything that exists only in SQLite."""
    with closing(open_db()) as connection:
        media = connection.execute(
            "SELECT id, original_name, media_type, mime_type, size_bytes, capture_time, "
            "capture_source, width, height, duration, checksum, is_favorite, is_archived, "
            "trashed_at, description, folder_path, latitude, longitude, "
            "telegram_message_id, upload_status FROM media_items WHERE client_id = ?",
            (client_id,),
        ).fetchall()
        albums = connection.execute(
            "SELECT id, name, description, created_at FROM albums WHERE client_id = ?",
            (client_id,),
        ).fetchall()
        album_media = connection.execute(
            "SELECT album_id, media_id FROM album_media WHERE album_id IN "
            "(SELECT id FROM albums WHERE client_id = ?)",
            (client_id,),
        ).fetchall()
        tags = connection.execute(
            "SELECT id, name FROM tags WHERE client_id = ?", (client_id,)
        ).fetchall()
        media_tags = connection.execute(
            "SELECT tag_id, media_id FROM media_tags WHERE tag_id IN "
            "(SELECT id FROM tags WHERE client_id = ?)",
            (client_id,),
        ).fetchall()
        people = connection.execute(
            "SELECT id, name, cover_face_id FROM people WHERE client_id = ?", (client_id,)
        ).fetchall()

    return {
        "format": "infinityvault-metadata",
        "version": 1,
        "exported_at": utc_now(),
        "client_id": client_id,
        "media": [dict(row) for row in media],
        "albums": [dict(row) for row in albums],
        "album_media": [dict(row) for row in album_media],
        "tags": [dict(row) for row in tags],
        "media_tags": [dict(row) for row in media_tags],
        "people": [dict(row) for row in people],
    }


def import_metadata(client_id: str, payload: dict[str, Any]) -> dict[str, int]:
    """Merge a snapshot back in. Existing rows win, so a restore never
    overwrites newer local edits with older backup data."""
    if payload.get("format") != "infinityvault-metadata":
        raise ValueError("That file is not an InfinityVault metadata backup")

    counts = {"media": 0, "albums": 0, "tags": 0, "album_links": 0, "tag_links": 0}
    now = utc_now()
    with closing(open_db()) as connection:
        for row in payload.get("media", []):
            exists = connection.execute(
                "SELECT 1 FROM media_items WHERE id = ?", (row["id"],)
            ).fetchone()
            if exists:
                continue
            connection.execute(
                """
                INSERT INTO media_items
                    (id, client_id, original_name, media_type, mime_type, size_bytes,
                     capture_time, capture_source, width, height, duration, local_path,
                     checksum, is_favorite, is_archived, trashed_at, description,
                     folder_path, latitude, longitude, telegram_message_id,
                     upload_status, file_state, thumb_state, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    row["id"], client_id, row["original_name"], row["media_type"],
                    row["mime_type"], row["size_bytes"], row["capture_time"],
                    row["capture_source"], row.get("width"), row.get("height"),
                    row.get("duration"), "", row.get("checksum") or "",
                    row.get("is_favorite") or 0, row.get("is_archived") or 0,
                    row.get("trashed_at"), row.get("description") or "",
                    row.get("folder_path"), row.get("latitude"), row.get("longitude"),
                    row.get("telegram_message_id"), row.get("upload_status") or "uploaded",
                    "missing", "pending", now, now,
                ),
            )
            counts["media"] += 1

        for row in payload.get("albums", []):
            exists = connection.execute("SELECT 1 FROM albums WHERE id = ?", (row["id"],)).fetchone()
            if not exists:
                connection.execute(
                    "INSERT INTO albums (id, client_id, name, description, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (row["id"], client_id, row["name"], row.get("description") or "",
                     row.get("created_at") or now, now),
                )
                counts["albums"] += 1

        for row in payload.get("tags", []):
            exists = connection.execute("SELECT 1 FROM tags WHERE id = ?", (row["id"],)).fetchone()
            if not exists:
                connection.execute(
                    "INSERT INTO tags (id, client_id, name, created_at) VALUES (?, ?, ?, ?)",
                    (row["id"], client_id, row["name"], now),
                )
                counts["tags"] += 1

        for row in payload.get("album_media", []):
            try:
                connection.execute(
                    "INSERT OR IGNORE INTO album_media (album_id, media_id) VALUES (?, ?)",
                    (row["album_id"], row["media_id"]),
                )
                counts["album_links"] += 1
            except sqlite3.Error:
                pass

        for row in payload.get("media_tags", []):
            try:
                connection.execute(
                    "INSERT OR IGNORE INTO media_tags (tag_id, media_id) VALUES (?, ?)",
                    (row["tag_id"], row["media_id"]),
                )
                counts["tag_links"] += 1
            except sqlite3.Error:
                pass

        connection.commit()
    return counts


def insert_restored_media(
    client_id: str,
    original_name: str,
    media_type: str,
    mime_type: str,
    size_bytes: int,
    capture_time: str,
    telegram_message_id: int,
    width: int | None = None,
    height: int | None = None,
    duration: float | None = None,
    album_message_id: int | None = None,
) -> str | None:
    """Create a row reconstructed from a Telegram message. Idempotent on
    message id, so re-running a restore does not duplicate anything.

    Dimensions and duration come from Telegram's own metadata. They matter
    because a restored row has no local file and no thumbnail yet: without them
    the timeline cannot lay out tiles or show a duration before anything has
    been downloaded. album_message_id preserves Telegram albums as albums.
    """
    with closing(open_db()) as connection:
        existing = connection.execute(
            "SELECT id FROM media_items WHERE client_id = ? AND telegram_message_id = ?",
            (client_id, telegram_message_id),
        ).fetchone()
        if existing:
            return None

        media_id = str(uuid4())
        now = utc_now()
        connection.execute(
            """
            INSERT INTO media_items
                (id, client_id, original_name, media_type, mime_type, size_bytes,
                 capture_time, capture_source, width, height, duration, local_path,
                 checksum, description, upload_status, telegram_message_id,
                 file_state, thumb_state, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 'uploaded', ?,
                    'missing', 'pending', ?, ?)
            """,
            (media_id, client_id, original_name, media_type, mime_type, size_bytes,
             capture_time, "Restored from Telegram", width, height, duration,
             telegram_message_id, now, now),
        )
        if album_message_id:
            _add_to_album_for_group(connection, client_id, media_id, album_message_id)
        connection.commit()
    return media_id


def _add_to_album_for_group(
    connection, client_id: str, media_id: str, grouped_id: int
) -> None:
    """Keep a Telegram album together as an InfinityVault album.

    Albums are Telegram's grouped_id, which is shared by every photo sent in one
    burst. Without this an import turns a 30-photo album into 30 loose photos,
    losing organisation the user already had.
    """
    # The grouped_id is part of the name, so UNIQUE(client_id, name) makes the
    # lookup idempotent without relying on origin_group existing yet. The date
    # leads because a raw grouped_id ("Telegram album 13544257181736869") is
    # meaningless to a person browsing their albums.
    import datetime as _dt

    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%d %b %Y")
    name = f"Telegram album - {stamp} ({grouped_id})"
    # Name encodes the grouped_id and albums are UNIQUE(client_id, name), so a
    # plain name lookup is already idempotent and needs no extra column.
    row = connection.execute(
        "SELECT id FROM albums WHERE client_id = ? AND name = ?", (client_id, name)
    ).fetchone()
    if row:
        album_id = row["id"]
    else:
        album_id = str(uuid4())
        now = utc_now()
        connection.execute(
            "INSERT INTO albums (id, client_id, name, description, created_at, updated_at) "
            "VALUES (?, ?, ?, '', ?, ?)",
            (album_id, client_id, name, now, now),
        )
    connection.execute(
        "INSERT OR IGNORE INTO album_media (album_id, media_id, added_at) VALUES (?, ?, ?)",
        (album_id, media_id, utc_now()),
    )


def set_local_path(media_id: str, local_path: str) -> None:
    """Record where a media original now lives, and mark it present.

    Imported rows start with no local file, so fetching the original from
    Telegram has to flip file_state back to 'present' at the same time --
    otherwise the row keeps claiming to be missing after the file arrives.
    """
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE media_items SET local_path = ?, file_state = 'present', updated_at = ? "
            "WHERE id = ?",
            (local_path, utc_now(), media_id),
        )
        connection.commit()


def media_counts(client_id: str) -> dict[str, int]:
    with closing(open_db()) as connection:
        row = connection.execute(
            "SELECT COUNT(*) AS n FROM media_items WHERE client_id = ?", (client_id,)
        ).fetchone()
        albums = connection.execute(
            "SELECT COUNT(*) AS n FROM albums WHERE client_id = ?", (client_id,)
        ).fetchone()
        tags = connection.execute(
            "SELECT COUNT(*) AS n FROM tags WHERE client_id = ?", (client_id,)
        ).fetchone()
    return {"media": row["n"], "albums": albums["n"], "tags": tags["n"]}


# ---------------------------------------------------------------------------
# Auto-backup bookkeeping
#
# Metadata only drifts when something changes, so the trigger is "N changes
# since the last backup" rather than "N uploads". That way a burst of uploads
# refreshes the backup once at the end instead of once per file, which would
# spam Saved Messages and waste Telegram rate limit.
# ---------------------------------------------------------------------------

AUTO_BACKUP_THRESHOLD = 25


def get_media_any_client(media_id: str) -> sqlite3.Row | None:
    """Look up a row without knowing its owner.

    Used by background workers (upload, thumbnails, faces) which receive only
    a media id and need the owning client to attribute their work.
    """
    with closing(open_db()) as connection:
        return connection.execute(
            "SELECT * FROM media_items WHERE id = ?", (media_id,)
        ).fetchone()


def get_setting(client_id: str, key: str) -> str | None:
    with closing(open_db()) as connection:
        row = connection.execute(
            "SELECT value FROM app_settings WHERE client_id = ? AND key = ?",
            (client_id, key),
        ).fetchone()
    return row["value"] if row else None


def set_setting(client_id: str, key: str, value: str) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            """
            INSERT INTO app_settings (client_id, key, value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(client_id, key) DO UPDATE SET
                value = excluded.value, updated_at = excluded.updated_at
            """,
            (client_id, key, value, utc_now()),
        )
        connection.commit()


def mark_library_changed(client_id: str) -> int:
    """Count a change since the last backup. Returns the running total."""
    current = int(get_setting(client_id, "changes_since_backup") or "0")
    current += 1
    set_setting(client_id, "changes_since_backup", str(current))
    return current


def clear_change_count(client_id: str) -> None:
    set_setting(client_id, "changes_since_backup", "0")
    set_setting(client_id, "last_backup_at", utc_now())


def backup_state(client_id: str) -> dict[str, Any]:
    pending = int(get_setting(client_id, "changes_since_backup") or "0")
    return {
        "changes_since_backup": pending,
        "last_backup_at": get_setting(client_id, "last_backup_at"),
        "threshold": AUTO_BACKUP_THRESHOLD,
        "due": pending >= AUTO_BACKUP_THRESHOLD,
    }


# ---------------------------------------------------------------------------
# GPS backfill
#
# Coordinates were never captured before this phase, so every photo uploaded
# earlier has NULL latitude/longitude even though the original in Telegram
# still carries its EXIF. Reading the local copy recovers it without
# re-downloading anything.
# ---------------------------------------------------------------------------


def photos_missing_gps(client_id: str) -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return list(connection.execute(
            """
            SELECT id, local_path FROM media_items
            WHERE client_id = ? AND media_type = 'photo'
              AND latitude IS NULL AND file_state = 'present'
            ORDER BY capture_time DESC
            """,
            (client_id,),
        ).fetchall())


def photos_missing_camera(client_id: str) -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return list(connection.execute(
            """
            SELECT id, local_path FROM media_items
            WHERE client_id = ? AND media_type = 'photo'
              AND COALESCE(camera_model, '') = '' AND COALESCE(camera_make, '') = ''
              AND file_state = 'present'
            ORDER BY capture_time DESC
            """,
            (client_id,),
        ).fetchall())


def set_media_camera(
    media_id: str, make: str | None, model: str | None, lens: str | None
) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE media_items SET camera_make = ?, camera_model = ?, lens_model = ?, updated_at = ? WHERE id = ?",
            (clean_camera_field(make), clean_camera_field(model), clean_camera_field(lens), utc_now(), media_id),
        )
        connection.commit()


def set_media_coordinates(media_id: str, latitude: float, longitude: float) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE media_items SET latitude = ?, longitude = ?, updated_at = ? WHERE id = ?",
            (latitude, longitude, utc_now(), media_id),
        )
        connection.commit()


def geotagged_points(client_id: str) -> list[sqlite3.Row]:
    """Every photo that has a real location, for the map."""
    with closing(open_db()) as connection:
        return list(connection.execute(
            """
            SELECT id, original_name, capture_time, latitude, longitude,
                   thumb_state, media_type
            FROM media_items
            WHERE client_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
              AND COALESCE(trashed_at, '') = ''
            ORDER BY capture_time DESC
            """,
            (client_id,),
        ).fetchall())


def place_groups(client_id: str, precision: float = 0.25) -> list[dict[str, Any]]:
    """Photos grouped into approximate areas, for Explore's Places section.

    There is no reverse geocoding here on purpose: resolving a city would mean
    sending every photo's coordinates to a third party, which this project
    rejected. So a "place" is a coordinate bucket -- rounded to `precision`
    degrees (0.25 is roughly 25 km) -- and it is labelled by its extremes and
    photo count rather than by an invented name.

    The UI must not imply these are real cities. It shows "Area near 28.6, 77.2"
    because that is what is actually known.
    """
    with closing(open_db()) as connection:
        rows = connection.execute(
            """
            SELECT
                ROUND(latitude / ?) * ? AS lat_bucket,
                ROUND(longitude / ?) * ? AS lon_bucket,
                COUNT(*) AS total
            FROM media_items
            WHERE client_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL
              AND COALESCE(trashed_at, '') = ''
            GROUP BY lat_bucket, lon_bucket
            HAVING total > 0
            ORDER BY total DESC
            LIMIT 24
            """,
            (precision, precision, precision, precision, client_id),
        ).fetchall()

    return [
        {
            "latitude": round(row["lat_bucket"], 3),
            "longitude": round(row["lon_bucket"], 3),
            "count": row["total"],
        }
        for row in rows
    ]


def tag_groups(client_id: str) -> list[dict[str, Any]]:
    """Tags with photo counts, for Explore."""
    with closing(open_db()) as connection:
        rows = connection.execute(
            """
            SELECT tags.id, tags.name, COUNT(media_tags.media_id) AS total
            FROM tags
            JOIN media_tags ON media_tags.tag_id = tags.id
            JOIN media_items ON media_items.id = media_tags.media_id
            WHERE tags.client_id = ? AND COALESCE(media_items.trashed_at, '') = ''
            GROUP BY tags.id
            ORDER BY total DESC, tags.name
            """,
            (client_id,),
        ).fetchall()
    return [{"id": r["id"], "name": r["name"], "count": r["total"]} for r in rows]


def person_groups(client_id: str) -> list[dict[str, Any]]:
    """People with face counts, for Explore."""
    with closing(open_db()) as connection:
        rows = connection.execute(
            """
            SELECT id, name, face_count FROM people
            WHERE client_id = ? AND face_count > 0
            ORDER BY face_count DESC, name
            LIMIT 24
            """,
            (client_id,),
        ).fetchall()
    return [
        {"id": r["id"], "name": r["name"] or "Unnamed", "count": r["face_count"]}
        for r in rows
    ]


def trash_duplicate_extras(client_id: str, checksum: str) -> int:
    """Move every extra copy of a checksum to the trash, keeping the oldest.

    Trash, not delete: `DELETE FROM media_items` cannot be undone from the UI,
    and a "duplicates" feature that silently destroys the wrong file is worse
    than no feature at all. Trashed rows can be restored from the Trash view,
    and Telegram still holds every original regardless.

    The oldest copy is kept so the timeline does not lose its original
    capture order, and its Telegram message id stays the canonical one.
    """
    with closing(open_db()) as connection:
        rows = connection.execute(
            """
            SELECT id FROM media_items
            WHERE client_id = ? AND checksum = ? AND COALESCE(trashed_at, '') = ''
            ORDER BY capture_time, created_at
            """,
            (client_id, checksum),
        ).fetchall()
        if len(rows) <= 1:
            return 0
        extras = [row["id"] for row in rows[1:]]
        now = utc_now()
        connection.executemany(
            "UPDATE media_items SET trashed_at = ?, updated_at = ? WHERE id = ?",
            [(now, now, media_id) for media_id in extras],
        )
        connection.commit()
    mark_library_changed(client_id)
    return len(extras)


def duplicate_groups(client_id: str) -> list[dict[str, Any]]:
    """Groups of media sharing a checksum -- the same bytes stored twice.

    Upload already refuses a second copy of a known checksum, so anything found
    here predates that guard. Reported rather than auto-deleted: the user
    decides, because removing media rows is not reversible from the UI.
    """
    with closing(open_db()) as connection:
        groups = connection.execute(
            """
            SELECT checksum, COUNT(*) AS copies, SUM(size_bytes) AS total_bytes
            FROM media_items
            WHERE client_id = ? AND COALESCE(checksum, '') <> '' AND COALESCE(trashed_at, '') = ''
            GROUP BY checksum HAVING COUNT(*) > 1
            ORDER BY SUM(size_bytes) DESC
            """,
            (client_id,),
        ).fetchall()

        results = []
        for group in groups:
            rows = connection.execute(
                """
                SELECT id, original_name, capture_time, size_bytes, thumb_state, local_path
                FROM media_items
                WHERE client_id = ? AND checksum = ? AND COALESCE(trashed_at, '') = ''
                ORDER BY capture_time, created_at
                """,
                (client_id, group["checksum"]),
            ).fetchall()
            results.append({
                "checksum": group["checksum"],
                "copies": group["copies"],
                # One copy is unavoidable; only the extras are reclaimable.
                "wasted_bytes": group["total_bytes"] - rows[0]["size_bytes"],
                "items": [
                    {
                        "id": row["id"],
                        "name": row["original_name"],
                        "captured_at": row["capture_time"],
                        "size": row["size_bytes"],
                        "preview_url": f"/api/media/{row['id']}/thumbnail",
                    }
                    for row in rows
                ],
            })
        return results


def on_this_day(client_id: str, month: int, day: int, years_back: int = 10) -> list[sqlite3.Row]:
    """Photos taken on this month/day in previous years.

    Matched on the month/day text rather than parsing dates in SQL, which
    SQLite cannot do reliably across the stored ISO strings.
    """
    with closing(open_db()) as connection:
        return list(connection.execute(
            """
            SELECT * FROM media_items
            WHERE client_id = ?
              AND COALESCE(trashed_at, '') = '' AND is_archived = 0
              AND substr(capture_time, 6, 2) = ?
              AND substr(capture_time, 9, 2) = ?
            ORDER BY capture_time DESC
            LIMIT ?
            """,
            (client_id, f"{month:02d}", f"{day:02d}", max(1, years_back) * 500),
        ).fetchall())


def recently_added(client_id: str, limit: int = 60) -> list[sqlite3.Row]:
    """Newest by *when they entered the library*, not when they were taken.

    A photo scanned from 2019 arrives today; a "recently added" view that
    sorted by capture_time would bury it.
    """
    with closing(open_db()) as connection:
        return list(connection.execute(
            """
            SELECT * FROM media_items
            WHERE client_id = ? AND COALESCE(trashed_at, '') = ''
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (client_id, max(1, min(limit, 500))),
        ).fetchall())


# -- video proxies ---------------------------------------------------------
# A proxy is a small, seek-friendly copy of a video. Playing the original meant
# downloading the whole file from Telegram first, so a large clip showed a
# spinner for minutes and scrubbing was impossible until it finished. The proxy
# is a few MB, plays while it downloads, and the original stays untouched.

def proxy_paths(media_id: str) -> Path:
    """Where a proxy lives, plus the temp file used while writing it."""
    return PROXY_DIR / f"{media_id}.mp4"


def enqueue_proxy_job(media_id: str) -> None:
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            """
            INSERT INTO thumbnail_jobs (id, media_id, status, attempts, created_at, updated_at)
            VALUES (?, ?, 'queued', 0, ?, ?)
            ON CONFLICT(media_id) DO UPDATE SET
                status = 'queued',
                last_error = NULL,
                updated_at = excluded.updated_at
            """,
            (str(uuid4()), media_id, now, now),
        )
        connection.execute(
            "UPDATE media_items SET proxy_state = 'pending' WHERE id = ?", (media_id,)
        )
        connection.commit()


def enqueue_all_proxies(client_id: str) -> int:
    """Queue every video that has no proxy yet."""
    with closing(open_db()) as connection:
        rows = connection.execute(
            "SELECT id FROM media_items WHERE client_id = ? AND media_type = 'video' "
            "AND proxy_state != 'ready'",
            (client_id,),
        ).fetchall()
    for row in rows:
        enqueue_proxy_job(row["id"])
    return len(rows)


def next_proxy_job() -> sqlite3.Row | None:
    """Next video awaiting a proxy.

    Deliberately separate from the thumbnail queue: proxies are expensive and
    optional, so they must never starve thumbnail generation for new uploads.
    """
    with closing(open_db()) as connection:
        return connection.execute(
            """
            SELECT media_items.id, media_items.local_path, media_items.duration
            FROM media_items
            WHERE media_items.media_type = 'video' AND media_items.proxy_state = 'pending'
              AND media_items.file_state = 'present'
            ORDER BY media_items.capture_time DESC
            LIMIT 1
            """
        ).fetchone()


def mark_proxy_done(media_id: str) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE media_items SET proxy_state = 'ready', updated_at = ? WHERE id = ?",
            (utc_now(), media_id),
        )
        connection.commit()


def mark_proxy_failed(media_id: str, error: str | None = None) -> None:
    with closing(open_db()) as connection:
        connection.execute(
            "UPDATE media_items SET proxy_state = 'failed', updated_at = ? WHERE id = ?",
            (utc_now(), media_id),
        )
        connection.commit()
    if error:
        import logging  # noqa: PLC0415
        logging.getLogger(__name__).warning("proxy failed for %s: %s", media_id, error)


def proxy_status(client_id: str) -> dict:
    with closing(open_db()) as connection:
        rows = connection.execute(
            "SELECT proxy_state, COUNT(*) AS total FROM media_items "
            "WHERE client_id = ? AND media_type = 'video' GROUP BY proxy_state",
            (client_id,),
        ).fetchall()
    counts = {row["proxy_state"]: row["total"] for row in rows}
    total = sum(counts.values())
    return {
        "total": total,
        "ready": counts.get("ready", 0),
        "pending": counts.get("pending", 0),
        "failed": counts.get("failed", 0),
    }


def proxy_ready(media_id: str) -> bool:
    with closing(open_db()) as connection:
        row = connection.execute(
            "SELECT proxy_state FROM media_items WHERE id = ?", (media_id,)
        ).fetchone()
    if not row or row["proxy_state"] != "ready":
        return False
    return proxy_paths(media_id).is_file()
