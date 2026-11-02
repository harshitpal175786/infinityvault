import asyncio
import os
import re
from dataclasses import dataclass
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

from . import db


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

    async def _upload_worker(self) -> None:
        while True:
            media_id = await self.upload_queue.get()
            try:
                await self._upload_media(media_id)
            except Exception as exc:  # Keep the worker alive for the next user's file.
                db.mark_failed(media_id, f"Upload failed: {exc}")
            finally:
                self.upload_queue.task_done()

    async def _upload_media(self, media_id: str) -> None:
        media = db.get_media_by_id(media_id)
        if not media:
            return

        client_id = media["client_id"]
        client = await self.get_authorized_client(client_id)
        if not client:
            db.mark_waiting_for_telegram(media_id)
            return

        local_path = Path(media["local_path"])
        if not local_path.exists():
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
