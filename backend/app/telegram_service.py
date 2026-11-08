import asyncio
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

from . import db
from .db import utc_now

logger = logging.getLogger(__name__)


class ThumbnailTooLargeToFetch(Exception):
    """Raised when an original is too large to download just for a thumbnail."""

# Ceiling for fetching one original from Telegram. Generous for a slow link, but
# finite: a stalled transfer used to hang the thumbnail queue forever.
DOWNLOAD_TIMEOUT_SECONDS = 120.0

# Never pull an original this large just to build a thumbnail. Saved Messages
# doubles as a file dump -- one real library held 3.8 GB of video, including a
# 1 GB film -- and downloading that to draw a 400px tile stalls the queue for
# no benefit. Such rows keep a placeholder tile and still play on demand,
# because the viewer streams from Telegram itself.
THUMBNAIL_MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024


PHONE_PATTERN = re.compile(r"^\+[1-9]\d{6,14}$")


@dataclass
class PendingLogin:
    client: TelegramClient
    phone_number: str
    phone_code_hash: str
    password_required: bool = False


class TelegramService:
    def __init__(self) -> None:
        self.pending: dict[str, PendingLogin] = {}
        self.clients: dict[str, TelegramClient] = {}
        self.client_locks: dict[str, asyncio.Lock] = {}
        self.media_locks: dict[str, asyncio.Lock] = {}
        self.upload_queue: asyncio.Queue[str] = asyncio.Queue()
        self.worker_task: asyncio.Task[None] | None = None

    @property
    def configured(self) -> bool:
        return bool(os.getenv("TELEGRAM_API_ID") and os.getenv("TELEGRAM_API_HASH"))

    def _api_id(self) -> int:
        try:
            return int(os.environ["TELEGRAM_API_ID"])
        except (KeyError, ValueError) as exc:
            raise RuntimeError("Telegram API ID is not configured") from exc

    def _api_hash(self) -> str:
        try:
            return os.environ["TELEGRAM_API_HASH"]
        except KeyError as exc:
            raise RuntimeError("Telegram API hash is not configured") from exc

    def _fernet(self) -> Fernet:
        configured_key = os.getenv("TELEGRAM_SESSION_KEY")
        key_path = db.DATA_DIR / "session.key"

        if configured_key:
            return Fernet(configured_key.encode())

        if key_path.exists():
            return Fernet(key_path.read_bytes())

        key_path.parent.mkdir(parents=True, exist_ok=True)
        key = Fernet.generate_key()
        key_path.write_bytes(key)
        try:
            key_path.chmod(0o600)
        except OSError:
            pass
        return Fernet(key)

    def _lock_for(self, client_id: str) -> asyncio.Lock:
        return self.client_locks.setdefault(client_id, asyncio.Lock())

    def _media_lock_for(self, media_id: str) -> asyncio.Lock:
        return self.media_locks.setdefault(media_id, asyncio.Lock())

    def _new_client(self) -> TelegramClient:
        return TelegramClient(
            StringSession(),
            self._api_id(),
            self._api_hash(),
            device_model="InfinityVault web",
            system_version="Web",
            app_version="0.1.0",
        )

    async def start(self) -> None:
        db.init_db()
        self.worker_task = asyncio.create_task(self._upload_worker())
        for media_id in db.reset_interrupted_jobs():
            self.upload_queue.put_nowait(media_id)

    async def stop(self) -> None:
        if self.worker_task:
            self.worker_task.cancel()
            await asyncio.gather(self.worker_task, return_exceptions=True)

        for pending in list(self.pending.values()):
            await pending.client.disconnect()
        for client in list(self.clients.values()):
            await client.disconnect()
        self.pending.clear()
        self.clients.clear()

    async def request_code(self, client_id: str, phone_number: str) -> dict[str, str]:
        if not self.configured:
            raise RuntimeError("Telegram is not configured on the server yet")
        phone_number = re.sub(r"[()\s-]", "", phone_number)
        if not PHONE_PATTERN.match(phone_number):
            raise ValueError("Enter your phone number with the country code, for example +14155552671")

        previous = self.pending.pop(client_id, None)
        if previous:
            await previous.client.disconnect()

        client = self._new_client()
        await client.connect()
        sent_code = await client.send_code_request(phone_number)
        self.pending[client_id] = PendingLogin(
            client=client,
            phone_number=phone_number,
            phone_code_hash=sent_code.phone_code_hash,
        )
        return {"status": "code_required"}

    async def verify_code(self, client_id: str, code: str, password: str | None = None) -> dict[str, str | int | None]:
        pending = self.pending.get(client_id)
        if not pending:
            raise ValueError("This sign-in attempt expired. Start again to request a new code.")
        if not code.strip().isdigit():
            raise ValueError("Enter the numeric Telegram verification code.")

        if pending.password_required:
            if not password:
                return {"status": "password_required"}
            await pending.client.sign_in(password=password)
        else:
            try:
                await pending.client.sign_in(
                    phone=pending.phone_number,
                    code=code.strip(),
                    phone_code_hash=pending.phone_code_hash,
                )
            except SessionPasswordNeededError:
                if not password:
                    pending.password_required = True
                    return {"status": "password_required"}
                await pending.client.sign_in(password=password)

        me = await pending.client.get_me()
        session = StringSession.save(pending.client.session)
        encrypted_session = self._fernet().encrypt(session.encode()).decode()
        display_name = " ".join(part for part in [me.first_name, me.last_name] if part) or "Telegram user"
        db.save_telegram_connection(
            client_id=client_id,
            encrypted_session=encrypted_session,
            telegram_user_id=me.id,
            display_name=display_name,
            username=me.username,
        )
        self.clients[client_id] = pending.client
        self.pending.pop(client_id, None)

        for media_id in db.queued_media_ids(client_id):
            self.upload_queue.put_nowait(media_id)

        return {
            "status": "connected",
            "display_name": display_name,
            "username": me.username,
            "telegram_user_id": me.id,
        }

    async def get_authorized_client(self, client_id: str) -> TelegramClient | None:
        async with self._lock_for(client_id):
            cached = self.clients.get(client_id)
            if cached and cached.is_connected():
                return cached

            connection = db.get_telegram_connection(client_id)
            if not connection:
                return None

            try:
                session = self._fernet().decrypt(connection["encrypted_session"].encode()).decode()
            except InvalidToken:
                return None

            client = TelegramClient(StringSession(session), self._api_id(), self._api_hash())
            await client.connect()
            if not await client.is_user_authorized():
                await client.disconnect()
                return None
            self.clients[client_id] = client
            return client

    async def disconnect(self, client_id: str) -> None:
        pending = self.pending.pop(client_id, None)
        if pending:
            await pending.client.disconnect()
        client = self.clients.pop(client_id, None)
        if client:
            await client.disconnect()
        db.delete_telegram_connection(client_id)

    async def enqueue(self, media_id: str) -> None:
        await self.upload_queue.put(media_id)

    async def delete_telegram_message(self, client_id: str, message_id: int) -> None:
        client = await self.get_authorized_client(client_id)
        if not client:
            raise ValueError("Reconnect Telegram before permanently deleting this original")
        await client.delete_messages("me", [message_id])

    async def _download_with_timeout(self, client, message, target, timeout: float):
        """Download with a hard ceiling, cleaning up a partial file on timeout."""
        try:
            return await asyncio.wait_for(
                client.download_media(message, file=str(target)), timeout=timeout
            )
        except asyncio.TimeoutError:
            logger.warning(
                "Telegram download timed out after %ss for message %s; skipping",
                timeout, getattr(message, "id", "?"),
            )
            try:
                Path(target).unlink(missing_ok=True)
                Path(str(target) + ".part").unlink(missing_ok=True)
            except OSError:
                pass
            return None

    async def ensure_local_original(self, media_row, allow_thumbnail: bool = False) -> str | None:
        """Download a row's original from Telegram and record the local path.

        Used by workers for media imported out of Saved Messages, which has a
        message id but no local file.

        allow_thumbnail lets the thumbnail worker accept Telegram's small
        rendition instead of the full file. It is OFF by default because a
        consumer that needs real pixels (face detection) must never be handed a
        320x240 thumbnail: storing one as the "original" made every face job
        come back empty.
        """
        message_id = media_row["telegram_message_id"]
        if not message_id:
            return None
        client = await self.get_authorized_client(media_row["client_id"])
        if not client:
            return None
        message = await client.get_messages("me", ids=message_id)
        if not message or not message.media:
            return None

        db.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        suffix = Path(media_row["original_name"] or f"restored-{message_id}").suffix.lower()[:12]
        target = db.UPLOAD_DIR / f"{media_row['id']}{suffix or '.bin'}"
        # Only a handful of images lack a Telegram-side thumbnail, and those are
        # usually small. Try the thumbnail first: it makes a 400px tile from a
        # few KB instead of downloading a 20 MB original over the user's data.
        is_photo = media_row["media_type"] == "photo"
        size_bytes = media_row["size_bytes"] or 0
        if not is_photo and size_bytes > THUMBNAIL_MAX_DOWNLOAD_BYTES:
            # Signal "skip, do not retry": the worker treats this as a final
            # state rather than a failure, so the queue moves on immediately.
            raise ThumbnailTooLargeToFetch(
                f"{size_bytes // (1024 * 1024)} MB is too large to download for a thumbnail"
            )

        if is_photo and getattr(message, "document", None) is not None:
            for size in ("y", "x", "m"):
                try:
                    fetched = await client.download_media(message, file=bytes, thumb=size)
                except Exception:
                    fetched = None
                if fetched:
                    try:
                        target.write_bytes(fetched)
                        stored = str(target.relative_to(db.DATA_DIR))
                        db.set_local_path(media_row["id"], stored)
                        return stored
                    except OSError:
                        break

        # A stalled transfer must not block the whole thumbnail queue: without
        # this one 20 MB video held up 202 other jobs indefinitely.
        downloaded = await self._download_with_timeout(
            client, message, target, timeout=DOWNLOAD_TIMEOUT_SECONDS
        )
        if not downloaded:
            return None
        try:
            stored = str(target.relative_to(db.DATA_DIR))
        except ValueError:
            stored = str(target)
        db.set_local_path(media_row["id"], stored)
        return stored

    async def telegram_media_path(self, client_id: str, media_id: str) -> Path:
        media = db.get_media(media_id, client_id)
        if not media:
            raise ValueError("Media not found")
        if not media["telegram_message_id"]:
            raise ValueError("This media has not finished backing up to Telegram")

        suffix = Path(media["original_name"]).suffix.lower()[:12]
        cache_path = db.CACHE_DIR / f"{media_id}{suffix}"
        if cache_path.exists() and cache_path.stat().st_size > 0:
            return cache_path

        async with self._media_lock_for(media_id):
            if cache_path.exists() and cache_path.stat().st_size > 0:
                return cache_path

            client = await self.get_authorized_client(client_id)
            if not client:
                raise ValueError("Reconnect Telegram to view this original")

            message = await client.get_messages("me", ids=media["telegram_message_id"])
            if not message or not message.media:
                raise ValueError("The Telegram media message could not be found")

            partial_path = cache_path.with_name(f"{cache_path.name}.part")
            partial_path.unlink(missing_ok=True)
            downloaded = await client.download_media(message, file=str(partial_path))
            if not downloaded or not partial_path.exists() or partial_path.stat().st_size == 0:
                partial_path.unlink(missing_ok=True)
                raise ValueError("Telegram did not return the original media")
            partial_path.replace(cache_path)

        return cache_path

    async def check_integrity(self, client_id: str, limit: int = 500) -> dict:
        """Verify that each backed-up original still exists in Telegram.

        Uses one metadata lookup per item. Messages are fetched in small
        batches because Telethon turns `get_messages(ids=[...])` into a single
        round trip, but very large id lists are rejected by the API.
        """
        client = await self.get_authorized_client(client_id)
        if not client:
            raise ValueError("Reconnect Telegram before checking your library")

        rows = db.list_media_for_integrity(client_id)
        # Newest first is the useful order; cap the work per invocation so a
        # huge library does not block the request for minutes.
        rows = rows[:limit]

        checked = {"ok": 0, "missing": 0}
        batch_size = 100
        for start in range(0, len(rows), batch_size):
            batch = rows[start:start + batch_size]
            ids = [row["telegram_message_id"] for row in batch]
            try:
                messages = await client.get_messages("me", ids=ids)
            except Exception as error:
                raise ValueError(f"Telegram rejected the lookup: {error}") from error

            # get_messages returns None for deleted ids and keeps positional order.
            by_id = {row["telegram_message_id"]: row for row in batch}
            for message_id, message in zip(ids, messages):
                row = by_id[message_id]
                # A message with no media means the file itself was removed but
                # the message survived, which is also a loss.
                exists = bool(message) and bool(getattr(message, "media", None))
                state = "ok" if exists else "missing"
                db.set_integrity_state(row["id"], state)
                checked[state] = checked.get(state, 0) + 1

        return {**checked, "total": len(rows), **db.integrity_summary(client_id)}

    async def backup_metadata(self, client_id: str) -> dict:
        """Upload a JSON snapshot of the local index to Saved Messages.

        Everything that exists only in SQLite -- albums, tags, favourites,
        descriptions, people names -- lives here. Without this, deleting
        backend/data loses that data permanently even though the originals
        survive in Telegram.
        """
        client = await self.get_authorized_client(client_id)
        if not client:
            raise ValueError("Reconnect Telegram before backing up your metadata")

        import json
        import tempfile

        payload = db.export_metadata(client_id)
        payload["client_id"] = client_id
        counts = db.media_counts(client_id)

        stamp = utc_now().replace(":", "-").replace(".", "-")
        filename = f"infinityvault-metadata-{stamp}.json"
        temp_path = db.DATA_DIR / filename
        temp_path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        try:
            message = await client.send_file(
                "me",
                str(temp_path),
                caption=(
                    "InfinityVault metadata backup\n"
                    f"Exported: {payload['exported_at']}\n"
                    f"Media: {counts['media']} | Albums: {counts['albums']} | Tags: {counts['tags']}"
                ),
                force_document=True,
            )
        finally:
            temp_path.unlink(missing_ok=True)

        db.clear_change_count(client_id)
        return {
            "message_id": message.id,
            "filename": filename,
            "media": counts["media"],
            "albums": counts["albums"],
            "tags": counts["tags"],
        }

    def _describe_unmarked_media(self, message) -> dict | None:
        """Describe a message that Telegram itself owns, not InfinityVault.

        scan_for_restore() used to skip anything without InfinityVault's caption,
        which meant media saved to Saved Messages directly was invisible. On a
        real account that was 386 of 391 items, so "backup" only ever saw its own
        uploads and could not restore a library the user had already built up.

        Everything needed is on the Telegram message: the date is the capture
        time, images carry their real pixel size, and videos carry duration and
        dimensions. Nothing external is consulted.
        """
        if message.photo:
            mime = "image/jpeg"
            name = None
            width = height = None
            duration = None
            size = 0
            # Telegram keeps several renditions; the largest is the best guess.
            for candidate in message.photo.sizes:
                if getattr(candidate, "w", None) and getattr(candidate, "h", None):
                    width, height = candidate.w, candidate.h
            for candidate in message.photo.sizes:
                if getattr(candidate, "size", None):
                    size = max(size, candidate.size)
        elif message.document:
            mime = (message.file.mime_type if message.file else None) or "application/octet-stream"
            name = getattr(message.file, "name", None) if message.file else None
            width = height = duration = None
            size = getattr(message.file, "size", 0) if message.file else 0
            for attribute in message.document.attributes:
                if hasattr(attribute, "w") and hasattr(attribute, "h"):
                    width, height = attribute.w, attribute.h
                if hasattr(attribute, "duration"):
                    duration = attribute.duration
                if getattr(attribute, "file_name", None):
                    name = attribute.file_name
        else:
            return None

        if not (mime or "").split("/")[0] in {"image", "video"}:
            return None

        return {
            "original_name": name,
            "media_type": "video" if mime.startswith("video/") else "photo",
            "mime_type": mime,
            "size_bytes": size or 0,
            "capture_time": message.date.isoformat() if message.date else None,
            "width": width,
            "height": height,
            "duration_seconds": duration,
            "album_message_id": message.grouped_id,
        }

    def _parse_backup_caption(self, message) -> dict | None:
        """Read capture time and original name out of an upload caption."""
        text = (message.message or "").strip()
        if db.RESTORE_CAPTION_MARKER not in text:
            return None
        capture_time, original = None, None
        for line in text.splitlines():
            if line.startswith("Captured:"):
                capture_time = line.split(":", 1)[1].strip()
            elif line.startswith("Original:"):
                original = line.split(":", 1)[1].strip()
        return {"capture_time": capture_time, "original_name": original}

    async def scan_for_restore(self, client_id: str, limit: int = 3000) -> dict:
        """Find InfinityVault backups in Saved Messages.

        Two sources, in order of value:
          1. A metadata backup document -> lossless (albums, tags, favourites).
          2. Upload captions -> rebuilds the photos, but not the organisation.

        Only reads message metadata; nothing is downloaded unless restoring.
        """
        client = await self.get_authorized_client(client_id)
        if not client:
            raise ValueError("Reconnect Telegram before scanning for backups")

        found_media: list[dict] = []
        metadata_message = None
        seen = 0

        async for message in client.iter_messages("me", limit=limit):
            seen += 1
            if not message.media:
                continue

            filename = getattr(message.file, "name", None) if message.file else None
            if filename and filename.startswith("infinityvault-metadata-") and filename.endswith(".json"):
                # Keep the newest metadata backup.
                if metadata_message is None:
                    metadata_message = message
                continue

            mime = getattr(message.file, "mime_type", None) if message.file else None
            size = getattr(message.file, "size", 0) if message.file else 0

            parsed = self._parse_backup_caption(message)
            if parsed:
                is_video = bool(mime and mime.startswith("video/"))
                found_media.append({
                    "telegram_message_id": message.id,
                    "original_name": parsed["original_name"] or filename or f"telegram-{message.id}",
                    "capture_time": parsed["capture_time"],
                    "media_type": "video" if is_video else "photo",
                    "mime_type": mime or "application/octet-stream",
                    "size_bytes": size,
                    "width": None,
                    "height": None,
                    "duration_seconds": None,
                    "album_message_id": None,
                    "own_backup": True,
                })
                continue

            # Not written by InfinityVault: media the user saved to Telegram
            # themselves. Adopt it, using Telegram's own metadata.
            described = self._describe_unmarked_media(message)
            if not described:
                continue
            described["telegram_message_id"] = message.id
            described["original_name"] = (
                described["original_name"] or filename or f"telegram-{message.id}"
            )
            described["own_backup"] = False
            found_media.append(described)

        own = sum(1 for item in found_media if item.get("own_backup"))
        return {
            "scanned": seen,
            "media_found": len(found_media),
            "own_backups": own,
            "adoptable": len(found_media) - own,
            "has_metadata_backup": metadata_message is not None,
            "metadata_message_id": metadata_message.id if metadata_message else None,
            "media": found_media,
        }

    async def apply_restore(self, client_id: str, limit: int = 3000) -> dict:
        """Rebuild the local index from Saved Messages."""
        scan = await self.scan_for_restore(client_id, limit=limit)

        # Prefer a real metadata backup: it carries albums, tags and favourites.
        metadata_result = None
        if scan["metadata_message_id"]:
            client = await self.get_authorized_client(client_id)
            if client:
                import json
                import tempfile

                message = await client.get_messages("me", ids=scan["metadata_message_id"])
                if message and message.media:
                    temp_path = db.DATA_DIR / f"restore-{message.id}.json"
                    try:
                        downloaded = await client.download_media(message, file=str(temp_path))
                        if downloaded:
                            payload = json.loads(Path(temp_path).read_text(encoding="utf-8"))
                            metadata_result = db.import_metadata(client_id, payload)
                    finally:
                        Path(temp_path).unlink(missing_ok=True)

        # If a metadata backup was imported, its rows already carry the same
        # telegram_message_id. insert_restored_media() is idempotent on that
        # id, so the caption pass below will skip them instead of duplicating.
        restored = 0
        for item in scan["media"]:
            created = db.insert_restored_media(
                client_id,
                original_name=item["original_name"],
                media_type=item["media_type"],
                mime_type=item["mime_type"],
                size_bytes=item["size_bytes"],
                capture_time=item["capture_time"] or utc_now(),
                telegram_message_id=item["telegram_message_id"],
                width=item.get("width"),
                height=item.get("height"),
                duration=item.get("duration_seconds"),
                album_message_id=item.get("album_message_id"),
            )
            if created:
                restored += 1
                db.enqueue_thumbnail_job(created)

        return {
            "restored_media": restored,
            "metadata_backup": metadata_result,
            "scanned": scan["scanned"],
            "found": scan["media_found"],
            "adoptable": scan.get("adoptable", 0),
        }

    async def _maybe_auto_backup(self, media_id: str) -> None:
        """Refresh the metadata snapshot once enough changes have piled up.

        Throttled by change count, not by upload, so a bulk import refreshes
        the backup once at the end instead of uploading a JSON file per photo
        (which would waste Telegram's rate limit and bury the user's chat).

        Failures are logged and swallowed: a backup problem must never make an
        upload look like it failed.
        """
        media = db.get_media_any_client(media_id)
        if not media:
            return
        client_id = media["client_id"]

        state = db.backup_state(client_id)
        if not state["due"]:
            return

        try:
            result = await self.backup_metadata(client_id)
            logger.info(
                "Auto-backed up metadata after %s changes (%s media, %s albums, %s tags)",
                state["changes_since_backup"], result["media"], result["albums"], result["tags"],
            )
        except Exception as exc:
            logger.warning("Auto metadata backup failed: %s", exc)

    async def _upload_worker(self) -> None:
        while True:
            media_id = await self.upload_queue.get()
            try:
                await self._upload_media(media_id)
            except Exception as exc:  # Keep the worker alive for the next user's file.
                db.mark_failed(media_id, f"Upload failed: {exc}")
            finally:
                self.upload_queue.task_done()
                await self._maybe_auto_backup(media_id)

    async def _upload_media(self, media_id: str) -> None:
        media = db.get_media_by_id(media_id)
        if not media:
            return

        client_id = media["client_id"]
        client = await self.get_authorized_client(client_id)
        if not client:
            db.mark_waiting_for_telegram(media_id)
            return

        # Relative paths (uploads/<uuid>.jpg) are stored deliberately so the
        # data directory can move. Path() alone resolves them against the
        # process CWD, which is backend/, so every upload failed here with
        # "local file is no longer available" even though the file was present.
        local_path = db.resolve_local_path(media["local_path"])
        if not local_path.is_file():
            db.mark_failed(media_id, "The local upload file is no longer available.")
            return

        db.mark_uploading(media_id)
        caption = (
            f"InfinityVault backup\n"
            f"Captured: {media['capture_time']}\n"
            f"Original: {media['original_name']}"
        )
        message = await client.send_file(
            "me",
            str(local_path),
            caption=caption,
            force_document=True,
            supports_streaming=media["media_type"] == "video",
        )
        db.mark_uploaded(media_id, message.id)
