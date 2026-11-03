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
        }
        for column, statement in migrations.items():
            if column not in columns:
                connection.execute(statement)
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
) -> str:
    media_id = str(uuid4())
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            """
            INSERT INTO media_items
                (id, client_id, original_name, media_type, mime_type, size_bytes,
                capture_time, capture_source, width, height, duration, local_path, checksum,
                upload_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
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
) -> list[sqlite3.Row]:
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
    with closing(open_db()) as connection:
        return list(connection.execute(
            f"SELECT * FROM media_items WHERE client_id = ? AND {state_filter} {album_filter} {search_filter} ORDER BY capture_time DESC",
            parameters,
        ).fetchall())


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
        return connection.execute(
            "SELECT * FROM media_items WHERE id = ? AND client_id = ?",
            (media_id, client_id),
        ).fetchone()


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
        return str(row["local_path"])


def list_albums(client_id: str) -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return list(connection.execute(
            """
            SELECT albums.*, COUNT(album_media.media_id) AS media_count
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
        connection.commit()
        return connection.execute("SELECT *, 0 AS media_count FROM albums WHERE id = ?", (album_id,)).fetchone()


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
        return len(valid_ids)


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
        connection.commit()
        return connection.execute("SELECT tags.*, 0 AS media_count FROM tags WHERE client_id = ? AND name = ? COLLATE NOCASE", (client_id, name.strip()[:100])).fetchone()


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
        connection.commit()


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
        "preview_url": f"{api_prefix}/media/{row['id']}/content",
        "telegram_url": f"{api_prefix}/media/{row['id']}/telegram-content" if row["telegram_message_id"] else None,
        "telegram_download_url": f"{api_prefix}/media/{row['id']}/telegram-download" if row["telegram_message_id"] else None,
        "upload_status": row["upload_status"],
        "upload_error": row["upload_error"],
        "telegram_message_id": row["telegram_message_id"],
    }
