from contextlib import asynccontextmanager
from datetime import datetime
import hashlib
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import db
from .face_service import FaceService, FaceUnavailable
from .telegram_service import TelegramService


@asynccontextmanager
async def lifespan(app: FastAPI):
    service = TelegramService()
    app.state.telegram_service = service
    await service.start()

    faces = FaceService()
    app.state.face_service = faces
    await faces.start()

    yield

    await faces.stop()
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


class MediaUpdate(BaseModel):
    favorite: bool | None = None
    archived: bool | None = None
    trashed: bool | None = None
    description: str | None = None
    captured_at: str | None = None
    folder_path: str | None = None


class AlbumCreate(BaseModel):
    name: str
    description: str = ""


class MediaSelection(BaseModel):
    media_ids: list[str]


class TagCreate(BaseModel):
    name: str


class TagSelection(BaseModel):
    media_ids: list[str]


def telegram_service(request: Request) -> TelegramService:
    return request.app.state.telegram_service


def face_service(request: Request) -> FaceService:
    return request.app.state.face_service


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
def get_media(
    view: str = Query(default="library"),
    search: str | None = Query(default=None),
    album_id: str | None = Query(default=None),
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> list[dict]:
    return [db.row_to_media(row) for row in db.list_media(client_id, view=view, query=search, album_id=album_id)]


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
    digest = hashlib.sha256()
    mime_type = file.content_type or "application/octet-stream"

    try:
        with local_path.open("wb") as destination:
            while chunk := await file.read(1024 * 1024):
                size_bytes += len(chunk)
                digest.update(chunk)
                destination.write(chunk)
    except Exception:
        local_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="The file could not be saved")
    finally:
        await file.close()

    checksum = digest.hexdigest()
    duplicate = db.find_media_by_checksum(client_id, checksum)
    if duplicate:
        local_path.unlink(missing_ok=True)
        result = db.row_to_media(duplicate)
        result["duplicate"] = True
        return result

    media_id = db.create_media(
        client_id=client_id,
        original_name=filename,
        media_type=media_type,
        mime_type=mime_type,
        size_bytes=size_bytes,
        capture_time=captured_at,
        capture_source=capture_source,
        width=width,
        height=height,
        duration=duration,
        local_path=str(local_path),
        checksum=checksum,
    )
    await telegram_service(request).enqueue(media_id)
    if media_type == "photo":
        # Faces are optional and never block the upload response.
        try:
            db.enqueue_face_job(media_id, client_id)
        except Exception:
            pass
    row = db.get_media(media_id, client_id)
    return db.row_to_media(row)


@app.patch("/api/media/{media_id}")
def update_media(
    media_id: str,
    payload: MediaUpdate,
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> dict:
    if payload.captured_at is not None:
        try:
            datetime.fromisoformat(payload.captured_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise HTTPException(status_code=400, detail="The capture time is not valid") from error
    row = db.update_media(
        media_id,
        client_id,
        is_favorite=payload.favorite,
        is_archived=payload.archived,
        trashed=payload.trashed,
        description=payload.description,
        capture_time=payload.captured_at,
        folder_path=payload.folder_path,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Media not found")
    return db.row_to_media(row)


@app.delete("/api/media/{media_id}")
async def delete_media(
    media_id: str,
    request: Request,
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> dict[str, bool]:
    row = db.get_media(media_id, client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Media not found")
    if row["telegram_message_id"]:
        try:
            await telegram_service(request).delete_telegram_message(client_id, row["telegram_message_id"])
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail="Telegram could not delete the original media") from error
    local_path = db.delete_media(media_id, client_id)
    if local_path:
        Path(local_path).unlink(missing_ok=True)
    (db.CACHE_DIR / f"{media_id}{Path(row['original_name']).suffix.lower()[:12]}").unlink(missing_ok=True)
    return {"deleted": True}


@app.get("/api/albums")
def get_albums(client_id: str = Header(default="local-user", alias="X-Client-ID")) -> list[dict]:
    return [dict(row) for row in db.list_albums(client_id)]


@app.post("/api/albums")
def post_album(payload: AlbumCreate, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> dict:
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Album name is required")
    try:
        return dict(db.create_album(client_id, payload.name, payload.description))
    except Exception as error:
        if "UNIQUE" in str(error).upper():
            raise HTTPException(status_code=409, detail="An album with that name already exists") from error
        raise


@app.delete("/api/albums/{album_id}")
def remove_album(album_id: str, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> dict[str, bool]:
    if not db.delete_album(album_id, client_id):
        raise HTTPException(status_code=404, detail="Album not found")
    return {"deleted": True}


@app.post("/api/albums/{album_id}/media")
def add_album_media(
    album_id: str,
    payload: MediaSelection,
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> dict[str, int]:
    added = db.add_media_to_album(album_id, payload.media_ids, client_id)
    if added < 0:
        raise HTTPException(status_code=404, detail="Album not found")
    return {"added": added}


@app.get("/api/tags")
def get_tags(client_id: str = Header(default="local-user", alias="X-Client-ID")) -> list[dict]:
    return [dict(row) for row in db.list_tags(client_id)]


@app.post("/api/tags")
def post_tag(payload: TagCreate, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> dict:
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Tag name is required")
    return dict(db.create_tag(client_id, payload.name))


@app.post("/api/tags/{tag_id}/media")
def add_tag_media(
    tag_id: str,
    payload: TagSelection,
    client_id: str = Header(default="local-user", alias="X-Client-ID"),
) -> dict[str, int]:
    added = db.add_tag_to_media(tag_id, payload.media_ids, client_id)
    if added < 0:
        raise HTTPException(status_code=404, detail="Tag not found")
    return {"added": added}


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
    if media_type == "photo":
        # Faces are optional and never block the upload response.
        try:
            db.enqueue_face_job(media_id, client_id)
        except Exception:
            pass
    row = db.get_media(media_id, client_id)
    return db.row_to_media(row)


# ---------------------------------------------------------------------------
# Face recognition (optional feature)
# ---------------------------------------------------------------------------

class PersonRename(BaseModel):
    name: str | None = None


class PersonMerge(BaseModel):
    source_id: str
    target_id: str


@app.get("/api/faces/status")
def faces_status(request: Request, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> dict:
    service = face_service(request)
    return {**service.status(), **db.face_job_stats(client_id)}


@app.post("/api/faces/scan")
def faces_scan(request: Request, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> dict:
    """Queue every photo that has not been analysed yet."""
    service = face_service(request)
    if not service.available and service.load_error:
        raise HTTPException(status_code=503, detail=service.load_error)
    queued = db.enqueue_all_photos(client_id)
    return {"queued": queued}


@app.post("/api/faces/cluster")
async def faces_cluster(request: Request, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> dict:
    """Group unassigned faces into people."""
    service = face_service(request)
    try:
        return await service.cluster(client_id)
    except FaceUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/people")
def get_people(client_id: str = Header(default="local-user", alias="X-Client-ID")) -> list[dict]:
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "face_count": row["face_count"],
            "cover_face_id": row["cover_face_id"],
            "cover_url": f"/api/faces/{row['cover_face_id']}/thumbnail" if row["cover_face_id"] else None,
        }
        for row in db.list_people(client_id)
    ]


@app.get("/api/people/{person_id}/media")
def person_media(person_id: str, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> list[dict]:
    return [db.row_to_media(row) for row in db.list_media_by_person(client_id, person_id)]


@app.patch("/api/people/{person_id}")
def rename_person(person_id: str, payload: PersonRename, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> dict:
    name = (payload.name or "").strip()[:100] or None
    row = db.set_person_name(person_id, client_id, name)
    if not row:
        raise HTTPException(status_code=404, detail="Person not found")
    return {"id": row["id"], "name": row["name"], "face_count": row["face_count"]}


@app.post("/api/people/merge")
def merge_people(payload: PersonMerge, client_id: str = Header(default="local-user", alias="X-Client-ID")) -> dict:
    if payload.source_id == payload.target_id:
        raise HTTPException(status_code=400, detail="Choose two different people to merge")
    moved = db.merge_people(payload.source_id, payload.target_id, client_id)
    if not moved:
        raise HTTPException(status_code=404, detail="One of those people was not found")
    return {"merged_faces": moved}


@app.get("/api/faces/{face_id}/thumbnail")
def face_thumbnail(face_id: str, client_id: str = Header(default="local-user", alias="X-Client-ID")):
    """Crop a single face from its original for the People grid."""
    from fastapi.responses import Response

    with db.closing(db.open_db()) as connection:
        face = connection.execute(
            "SELECT faces.*, media_items.local_path FROM faces "
            "JOIN media_items ON media_items.id = faces.media_id "
            "WHERE faces.id = ? AND faces.client_id = ?",
            (face_id, client_id),
        ).fetchone()
    if not face:
        raise HTTPException(status_code=404, detail="Face not found")

    try:
        import cv2  # noqa: PLC0415
    except ImportError as error:
        raise HTTPException(status_code=503, detail="Face thumbnails need opencv installed") from error

    image = cv2.imread(str(face["local_path"]))
    if image is None:
        raise HTTPException(status_code=404, detail="The original image is no longer available")

    x, y = int(face["bbox_x"]), int(face["bbox_y"])
    w, h = int(face["bbox_w"]), int(face["bbox_h"])
    # Pad the crop so faces are not cropped to the jawline.
    pad = int(max(w, h) * 0.28)
    ih, iw = image.shape[:2]
    x1, y1 = max(0, x - pad), max(0, y - pad)
    x2, y2 = min(iw, x + w + pad), min(ih, y + h + pad)
    crop = image[y1:y2, x1:x2]
    if crop.size == 0:
        raise HTTPException(status_code=404, detail="The face region could not be cropped")

    size = 160
    crop = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
    ok, buffer = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    if not ok:
        raise HTTPException(status_code=500, detail="The face thumbnail could not be encoded")
    return Response(content=buffer.tobytes(), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})
