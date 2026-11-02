from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import db
from .telegram_service import TelegramService


@asynccontextmanager
async def lifespan(app: FastAPI):
    service = TelegramService()
    app.state.telegram_service = service
    await service.start()
    yield
    await service.stop()


app = FastAPI(title="InfinityVault API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TelegramStartRequest(BaseModel):
    phone_number: str


class TelegramVerifyRequest(BaseModel):
    code: str
    password: str | None = None


def telegram_service(request: Request) -> TelegramService:
    return request.app.state.telegram_service


def friendly_telegram_error(error: Exception) -> str:
    error_name = error.__class__.__name__
    messages = {
        "PhoneCodeInvalidError": "That Telegram code is not correct. Check the latest code and try again.",
        "PhoneCodeExpiredError": "That Telegram code expired. Start again to request a new code.",
        "PhoneNumberInvalidError": "Telegram did not accept that phone number. Include the country code.",
        "PhoneNumberBannedError": "Telegram cannot authorize this phone number.",
        "FloodWaitError": "Telegram asked us to wait before trying again. Please try again later.",
        "PasswordHashInvalidError": "That Telegram password is not correct.",
        "AuthKeyUnregisteredError": "The Telegram session expired. Please connect again.",
    }
    return messages.get(error_name, "Telegram could not complete the sign-in. Please try again.")


@app.get("/health", include_in_schema=False)
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/telegram/status")
def telegram_status(request: Request, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> dict:
    service = telegram_service(request)
    connection = db.get_telegram_connection(client_id)
    return {
        "configured": service.configured,
        "connected": connection is not None,
        "display_name": connection["display_name"] if connection else None,
        "username": connection["username"] if connection else None,
    }


@app.post("/api/telegram/auth/start")
async def start_telegram_auth(
    payload: TelegramStartRequest,
    request: Request,
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> dict:
    try:
        return await telegram_service(request).request_code(client_id, payload.phone_number.strip())
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=400, detail=friendly_telegram_error(error)) from error


@app.post("/api/telegram/auth/verify")
async def verify_telegram_auth(
    payload: TelegramVerifyRequest,
    request: Request,
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> dict:
    try:
        return await telegram_service(request).verify_code(client_id, payload.code, payload.password)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=400, detail=friendly_telegram_error(error)) from error


@app.post("/api/telegram/disconnect")
async def disconnect_telegram(
    request: Request,
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> dict[str, bool]:
    await telegram_service(request).disconnect(client_id)
    return {"connected": False}


@app.get("/api/media")
def get_media(client_id: str = Header(default="local-user", alias="X-Client-ID")) -> list[dict]:
    return [db.row_to_media(row) for row in db.list_media(client_id)]


@app.post("/api/media")
async def upload_media(
    request: Request,
    file: UploadFile = File(...),
    captured_at: str = Form(...),
    capture_source: str = Form("File date fallback"),
    media_type: str = Form(...),
    width: int | None = Form(default=None),
    height: int | None = Form(default=None),
    duration: float | None = Form(default=None),
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> dict:
    if media_type not in {"photo", "video"}:
        raise HTTPException(status_code=400, detail="Only photos and videos can be uploaded")
    try:
        datetime.fromisoformat(captured_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise HTTPException(status_code=400, detail="The capture time is not valid") from error

    filename = file.filename or "untitled-media"
    suffix = Path(filename).suffix.lower()[:12]
    local_path = db.UPLOAD_DIR / f"{uuid4()}{suffix}"
    size_bytes = 0

    try:
        with local_path.open("wb") as destination:
            while chunk := await file.read(1024 * 1024):
                size_bytes += len(chunk)
                destination.write(chunk)
    except Exception:
        local_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="The file could not be saved")
    finally:
        await file.close()

    media_id = db.create_media(
        client_id=client_id,
        original_name=filename,
        media_type=media_type,
        mime_type=file.content_type or "application/octet-stream",
        size_bytes=size_bytes,
        capture_time=captured_at,
        capture_source=capture_source,
        width=width,
        height=height,
        duration=duration,
        local_path=str(local_path),
    )
    await telegram_service(request).enqueue(media_id)
    row = db.get_media(media_id, client_id)
    return db.row_to_media(row)


@app.get("/api/media/{media_id}/content")
def media_content(
    media_id: str,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> FileResponse:
    effective_client_id = query_client_id or client_id or "local-user"
    row = db.get_media(media_id, effective_client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Media not found")
    path = Path(row["local_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Media preview is no longer available")
    return FileResponse(path, media_type=row["mime_type"], filename=row["original_name"], content_disposition_type="inline")


@app.get("/api/media/{media_id}/telegram-content")
async def telegram_media_content(
    media_id: str,
    request: Request,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> FileResponse:
    effective_client_id = query_client_id or client_id or "local-user"
    service = telegram_service(request)
    try:
        path = await service.telegram_media_path(effective_client_id, media_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail="Telegram could not return this media right now") from error

    row = db.get_media(media_id, effective_client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Media not found")
    return FileResponse(path, media_type=row["mime_type"], filename=row["original_name"], content_disposition_type="inline")


@app.get("/api/media/{media_id}/telegram-download")
async def telegram_media_download(
    media_id: str,
    request: Request,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> FileResponse:
    effective_client_id = query_client_id or client_id or "local-user"
    service = telegram_service(request)
    try:
        path = await service.telegram_media_path(effective_client_id, media_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail="Telegram could not return this media right now") from error

    row = db.get_media(media_id, effective_client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Media not found")
    return FileResponse(path, media_type=row["mime_type"], filename=row["original_name"], content_disposition_type="attachment")


@app.post("/api/media/{media_id}/retry")
async def retry_media(
    media_id: str,
    request: Request,
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> dict:
    if not db.retry_media(media_id, client_id):
        raise HTTPException(status_code=404, detail="Media not found")
    await telegram_service(request).enqueue(media_id)
    row = db.get_media(media_id, client_id)
    return db.row_to_media(row)
