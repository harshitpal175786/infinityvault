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
                telegram_message_id INTEGER,
                upload_status TEXT NOT NULL,
                upload_error TEXT,
                upload_attempts INTEGER NOT NULL DEFAULT 0,
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

            CREATE INDEX IF NOT EXISTS media_items_client_time
                ON media_items(client_id, capture_time DESC);
            CREATE INDEX IF NOT EXISTS upload_jobs_status
                ON upload_jobs(status, updated_at);
            """
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
) -> str:
    media_id = str(uuid4())
    now = utc_now()
    with closing(open_db()) as connection:
        connection.execute(
            """
            INSERT INTO media_items
                (id, client_id, original_name, media_type, mime_type, size_bytes,
                 capture_time, capture_source, width, height, duration, local_path,
                 upload_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
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


def get_media_by_id(media_id: str) -> sqlite3.Row | None:
    with closing(open_db()) as connection:
        return connection.execute(
            "SELECT * FROM media_items WHERE id = ?",
            (media_id,),
        ).fetchone()


def list_media(client_id: str) -> list[sqlite3.Row]:
    with closing(open_db()) as connection:
        return list(connection.execute(
            "SELECT * FROM media_items WHERE client_id = ? ORDER BY capture_time DESC",
            (client_id,),
        ).fetchall())


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
        "preview_url": f"{api_prefix}/media/{row['id']}/content",
        "telegram_url": f"{api_prefix}/media/{row['id']}/telegram-content" if row["telegram_message_id"] else None,
        "telegram_download_url": f"{api_prefix}/media/{row['id']}/telegram-download" if row["telegram_message_id"] else None,
        "upload_status": row["upload_status"],
        "upload_error": row["upload_error"],
        "telegram_message_id": row["telegram_message_id"],
    }
