import hashlib
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from . import auth, db
from .face_service import FaceService, FaceUnavailable
from .thumbnail_service import ThumbnailService
from . import proxy_service

logger = logging.getLogger(__name__)
# uvicorn configures its own loggers but leaves ours without a handler, so
# reconciliation and face-service messages would be invisible. Propagate to a
# root logger with a plain format instead.
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(name)s - %(message)s")
from .telegram_service import TelegramService


@asynccontextmanager
async def lifespan(app: FastAPI):
    service = TelegramService()
    app.state.telegram_service = service
    await service.start()

    # Access control. Read from the private env file so a launcher that does
    # not export the variable still works.
    env_file = Path(os.getenv("INFINITYVAULT_ENV_FILE", Path.home() / ".config" / "infinityvault" / ".env"))
    token = auth.load_token(env_file)
    app.state.access_token = token
    problem = auth.validate_configuration(token)
    if problem:
        logger.warning("Access control: %s", problem)
    else:
        logger.info("Access control: token required for /api requests")

    # Repair stale/absolute paths before any service reads them.
    try:
        stats = db.reconcile_local_files()
        if stats["rebased"] or stats["restored"] or stats["missing"]:
            logger.info(
                "Local file reconciliation: %s ok, %s rebased, %s restored, %s missing",
                stats["ok"], stats["rebased"], stats["restored"], stats["missing"],
            )
    except Exception:
        logger.exception("Local file reconciliation failed")

    # Fold any pre-Phase-3.2 client ids into the single owner id. Without this a
    # real vault stays split, and the owner's own library looks empty.
    try:
        adopted = adopt_orphan_rows()
        if adopted:
            logger.info("Adopted %s row(s) from legacy client ids into the owner library", adopted)
    except Exception:
        logger.exception("Legacy client id adoption failed")

    thumbs = ThumbnailService()
    # The worker fetches originals for media imported from Saved Messages, which
    # has no local file until something downloads it.
    thumbs.telegram = app.state.telegram_service
    app.state.thumbnail_service = thumbs
    await thumbs.start()

    faces = FaceService()
    app.state.face_service = faces
    await faces.start()

    # Proxies run last and in their own serial worker: encoding is expensive,
    # so it must never delay thumbnails or face detection for new uploads.
    proxies = proxy_service.ProxyService()
    app.state.proxy_service = proxies
    await proxies.ensure_worker()

    yield

    await proxies.stop()
    await faces.stop()
    await thumbs.stop()
    await service.stop()


app = FastAPI(title="InfinityVault API", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Ports 5173 (dev) plus any extra origin from the env file, so a proxy or
    # an alternate dev port works without editing code.
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5180",
        "http://127.0.0.1:5180",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_access_token(request: Request, call_next):
    """Reject unauthenticated API access.

    A single-owner vault needs "is this the owner?", not identity. See
    app/auth.py for why OAuth was rejected.

    Escape hatch: while no token is configured the API stays open and reports
    itself as unsecured, so a user who has never run `token` is not locked out
    of their own library. /api/auth/status always tells the truth about this.
    """
    path = request.url.path
    if request.method == "OPTIONS" or path in auth.PUBLIC_PATHS or not path.startswith("/api"):
        return await call_next(request)

    expected = getattr(app.state, "access_token", None)
    if not expected:
        # Unconfigured: allow, but every response advertises the state.
        response = await call_next(request)
        response.headers["X-InfinityVault-Security"] = "unsecured"
        return response

    provided = auth.extract_token(dict(request.headers), request.query_params.get("access_token"))
    if not auth.token_is_valid(provided, expected):
        return JSONResponse(
            status_code=401,
            content={"detail": "This request needs the InfinityVault access token."},
            headers={"WWW-Authenticate": "Bearer"},
        )
    return await call_next(request)


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


def thumbnail_service(request: Request) -> ThumbnailService:
    return request.app.state.thumbnail_service


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


# This vault has exactly one owner, so the client id is server state rather
# than a value the caller gets to choose. Leaving a "local-user" default in
# place meant an authenticated request with no header silently read whatever
# rows were stored under that id -- the request still succeeded, which hid the
# mistake. Requests must now name the id explicitly.
def read_image_camera(path: Path) -> tuple[str | None, str | None, str | None]:
    """Pull Make/Model/LensModel out of an image's EXIF.

    Returns (make, model, lens), any of which may be None.
    """
    try:
        from PIL import Image, ExifTags  # noqa: PLC0415
    except ImportError:
        return None, None, None

    try:
        with Image.open(path) as image:
            exif = image.getexif()
            if not exif:
                return None, None, None
            tags = {ExifTags.TAGS.get(key, key): value for key, value in exif.items()}
    except Exception:
        return None, None, None

    def pick(*names: str) -> str | None:
        for name in names:
            value = tags.get(name)
            if isinstance(value, bytes):
                value = value.decode("utf-8", "ignore")
            if isinstance(value, str):
                cleaned = value.replace("\x00", " ").strip()
                if cleaned:
                    return cleaned[:100]
        return None

    return pick("Make"), pick("Model"), pick("LensModel")


def read_image_coordinates(path: Path) -> tuple[float, float] | None:
    """Pull GPS out of an image's EXIF, if it has a usable fix.

    Pillow is already a core dependency for thumbnails, so this adds nothing.
    Returns None rather than raising for the many photos with no EXIF at all.
    """
    try:
        from PIL import Image  # noqa: PLC0415
        from PIL.ExifTags import GPSTAGS, TAGS  # noqa: PLC0415
    except ImportError:
        return None

    try:
        with Image.open(path) as image:
            exif = image.getexif()
            if not exif:
                return None
            gps_info = exif.get_ifd(0x8825)
    except Exception:
        return None
    if not gps_info:
        return None

    gps = {GPSTAGS.get(key, key): value for key, value in gps_info.items()}

    def to_degrees(value) -> float | None:
        try:
            if isinstance(value, (tuple, list)) and len(value) == 3:
                degrees, minutes, seconds = (float(part) for part in value)
                return degrees + minutes / 60 + seconds / 3600
            return float(value)
        except (TypeError, ValueError, ZeroDivisionError):
            return None

    latitude = to_degrees(gps.get("GPSLatitude"))
    longitude = to_degrees(gps.get("GPSLongitude"))
    if latitude is None or longitude is None:
        return None
    if str(gps.get("GPSLatitudeRef", "N")).upper().startswith("S"):
        latitude = -latitude
    if str(gps.get("GPSLongitudeRef", "E")).upper().startswith("W"):
        longitude = -longitude

    normalized_lat, normalized_lon = db.normalize_coordinates(latitude, longitude)
    if normalized_lat is None or normalized_lon is None:
        return None
    return normalized_lat, normalized_lon


# This is a single-owner vault: there is exactly one library, and the token in
# Phase 3 is what proves you are its owner. `client_id` therefore no longer
# identifies *which* library -- it identifies nothing at all -- but the column
# is still on every row and every URL, and rewriting 50 routes at once would put
# the whole API at risk for no user-visible gain.
#
# So the client id became a default instead of a requirement: a caller that
# sends one (the browser does, and image URLs must) is honoured, and a caller
# that sends none gets the owner. This removes the class of 400 that image
# routes kept hitting, and it matches the model the PRD describes.
OWNER_CLIENT_ID = "owner"


def resolve_client_id(client_id: str | None, query_client_id: str | None = None) -> str:
    """The library to act on. Always resolves; never raises.

    Order of preference:

    1. An explicit id from the caller (header or query), because the browser
       sends one and image URLs must.
    2. The id the existing library was actually written with. This matters: a
       vault created before this change has rows under a browser-generated
       UUID, and defaulting straight to "owner" would make every one of those
       photos invisible -- the library would look empty. Reading the id back
       from the rows keeps old data reachable without a migration.
    3. OWNER_CLIENT_ID, for a genuinely empty database.
    """
    # A single-owner vault ignores the caller's id entirely. Every browser used
    # to invent a random UUID and store it in localStorage, so honouring it means
    # a fresh browser sees an empty library even though the photos exist, and a
    # cleared cache silently "loses" everything. Phase 3 made the access token
    # the proof of ownership, so the id carries no authority now.
    #
    # Rows are migrated to OWNER_CLIENT_ID on boot by adopt_orphan_rows(), so
    # there is nothing left to address per-client.
    return OWNER_CLIENT_ID


_owner_cache: str | None = None

# Sentinel used for a caller that sent no id at all. It is never a real library
# id, so "no id" and "the owner" cannot be confused.
_UNOWNED_CLIENT_IDS = {"", "owner"}


def adopt_orphan_rows() -> int:
    """Fold every pre-existing client id into the single owner id.

    This is the Phase 3.2 migration that was documented but never run. It
    matters because the old design gave *every browser* its own random id, so a
    real vault ends up split across several of them: the owner's own photos can
    be invisible simply because they are sitting under a UUID nobody sends any
    more. Merging them is the whole point of a single-owner library.

    Safe to call on every boot: it is one UPDATE, it touches only rows whose id
    is not already the owner id, and it cannot lose or duplicate a row because
    client_id is not part of any primary key. Collisions are impossible because
    media ids are UUIDs.
    """
    with db.closing(db.open_db()) as connection:
        orphans = [
            row["client_id"]
            for row in connection.execute(
                "SELECT DISTINCT client_id FROM media_items WHERE client_id != ?",
                (OWNER_CLIENT_ID,),
            ).fetchall()
        ]
        if not orphans:
            return 0
        placeholders = ",".join("?" * len(orphans))
        moved = connection.execute(
            f"UPDATE media_items SET client_id = ? WHERE client_id IN ({placeholders})",
            [OWNER_CLIENT_ID, *orphans],
        ).rowcount
        # Albums, tags and people are per-owner too, and would otherwise stay
        # stranded on a dead id alongside the photos that were just adopted.
        for table in ("albums", "tags", "people", "app_settings"):
            try:
                connection.execute(
                    f"UPDATE {table} SET client_id = ? WHERE client_id IN ({placeholders})",
                    [OWNER_CLIENT_ID, *orphans],
                )
            except Exception:
                pass
        connection.commit()
    return moved


@app.get("/api/auth/status")
def auth_status(request: Request) -> dict:
    """Whether this instance requires a token. Public by design: the client
    must be able to learn that it needs one before it can send one."""
    token = getattr(request.app.state, "access_token", None)
    return {
        "required": bool(token),
        "configured": bool(token),
        "problem": auth.validate_configuration(token),
    }


@app.get("/api/telegram/status")
def telegram_status(request: Request, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    client_id = resolve_client_id(client_id)
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
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict:
    client_id = resolve_client_id(client_id)
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
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict:
    client_id = resolve_client_id(client_id)
    try:
        return await telegram_service(request).verify_code(client_id, payload.code, payload.password)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=400, detail=friendly_telegram_error(error)) from error


@app.post("/api/telegram/disconnect")
async def disconnect_telegram(
    request: Request,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict[str, bool]:
    client_id = resolve_client_id(client_id)
    await telegram_service(request).disconnect(client_id)
    return {"connected": False}


@app.get("/api/media")
def get_media(
    view: str = Query(default="library"),
    search: str | None = Query(default=None),
    album_id: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    media_type: str | None = Query(default=None),
    has_faces: bool | None = Query(default=None),
    has_location: bool | None = Query(default=None),
    camera: str | None = Query(default=None),
    person_id: str | None = Query(default=None),
    tag_id: str | None = Query(default=None),
    place: str | None = Query(default=None),
    favorite: bool | None = Query(default=None),
    sort: str = Query(default="newest"),
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> Any:
    """List media, newest first.

    Pagination is opt-in so an existing client that sends no `cursor`/`limit`
    still receives a plain array. Passing either switches the response to
    `{items, next_cursor}`, so the two shapes never mix.
    """

    client_id = resolve_client_id(client_id, query_client_id)
    if cursor is None and limit is None:
        rows = db.list_media(
            client_id,
            view=view,
            query=search,
            album_id=album_id,
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
            sort=sort,
        )
        return [db.row_to_media(row) for row in rows]

    try:
        rows, next_cursor = db.list_media_page(
            client_id,
            view=view,
            query=search,
            album_id=album_id,
            cursor=cursor,
            limit=limit or db.DEFAULT_PAGE_SIZE,
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
            sort=sort,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return {"items": [db.row_to_media(row) for row in rows], "next_cursor": next_cursor}


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
    latitude: float | None = Form(default=None),
    longitude: float | None = Form(default=None),
    camera_make: str | None = Form(default=None),
    camera_model: str | None = Form(default=None),
    lens_model: str | None = Form(default=None),
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict:
    client_id = resolve_client_id(client_id)
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
        # Stored relative to DATA_DIR so the library survives a folder move.
        local_path=db.to_relative(local_path),
        checksum=checksum,
        latitude=latitude,
        longitude=longitude,
        camera_make=camera_make,
        camera_model=camera_model,
        lens_model=lens_model,
    )
    # Thumbnails are generated in the background for photos and videos alike.
    try:
        db.enqueue_thumbnail_job(media_id)
    except Exception:
        pass

    await telegram_service(request).enqueue(media_id)

    # The media type lives on the row, not in this scope: retry has no upload
    # form to read it from. Reading it here is why this route used to raise
    # NameError *after* the upload had already been queued, so the retry looked
    # like a 500 while quietly succeeding.
    row = db.get_media(media_id, client_id)
    media_type = row["media_type"] if row else None
    if media_type == "photo":
        try:
            db.enqueue_face_job(media_id, client_id)
        except Exception:
            pass
    elif media_type == "video":
        # A proxy is what makes playback start in a second rather than after a
        # full Telegram download, so queue it the moment a video arrives.
        try:
            db.enqueue_proxy_job(media_id)
        except Exception:
            pass
    return db.row_to_media(row)


@app.patch("/api/media/{media_id}")
def update_media(
    media_id: str,
    payload: MediaUpdate,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict:
    client_id = resolve_client_id(client_id)
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
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict[str, bool]:
    client_id = resolve_client_id(client_id)
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
        db.resolve_local_path(local_path).unlink(missing_ok=True)
    (db.CACHE_DIR / f"{media_id}{Path(row['original_name']).suffix.lower()[:12]}").unlink(missing_ok=True)
    return {"deleted": True}


@app.get("/api/albums")
def get_albums(client_id: str | None = Header(default=None, alias="X-Client-ID")) -> list[dict]:
    client_id = resolve_client_id(client_id)
    return [dict(row) for row in db.list_albums(client_id)]


@app.post("/api/albums")
def post_album(payload: AlbumCreate, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    client_id = resolve_client_id(client_id)
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Album name is required")
    try:
        return dict(db.create_album(client_id, payload.name, payload.description))
    except Exception as error:
        if "UNIQUE" in str(error).upper():
            raise HTTPException(status_code=409, detail="An album with that name already exists") from error
        raise


@app.delete("/api/albums/{album_id}")
def remove_album(album_id: str, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict[str, bool]:
    client_id = resolve_client_id(client_id)
    if not db.delete_album(album_id, client_id):
        raise HTTPException(status_code=404, detail="Album not found")
    return {"deleted": True}


@app.post("/api/albums/{album_id}/media")
def add_album_media(
    album_id: str,
    payload: MediaSelection,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict[str, int]:
    client_id = resolve_client_id(client_id)
    added = db.add_media_to_album(album_id, payload.media_ids, client_id)
    if added < 0:
        raise HTTPException(status_code=404, detail="Album not found")
    return {"added": added}


@app.get("/api/tags")
def get_tags(client_id: str | None = Header(default=None, alias="X-Client-ID")) -> list[dict]:
    client_id = resolve_client_id(client_id)
    return [dict(row) for row in db.list_tags(client_id)]


@app.post("/api/tags")
def post_tag(payload: TagCreate, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    client_id = resolve_client_id(client_id)
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Tag name is required")
    return dict(db.create_tag(client_id, payload.name))


@app.post("/api/tags/{tag_id}/media")
def add_tag_media(
    tag_id: str,
    payload: TagSelection,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict[str, int]:
    client_id = resolve_client_id(client_id)
    added = db.add_tag_to_media(tag_id, payload.media_ids, client_id)
    if added < 0:
        raise HTTPException(status_code=404, detail="Tag not found")
    return {"added": added}


@app.get("/api/media/{media_id}/thumbnail")
def media_thumbnail(
    media_id: str,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
):
    """Small cached WebP for the grid.

    Falls back to the original when a thumbnail has not been generated yet, so
    a freshly imported photo is never a broken tile. The `thumb_state` field
    tells the UI whether it is looking at a real thumbnail.
    """

    # <img>/<video> cannot send X-Client-ID, so the query param is the normal
    # path for these endpoints -- resolve it here rather than ignoring it and
    # rejecting every image request with 400.
    client_id = resolve_client_id(client_id, query_client_id)
    row = db.get_media(media_id, client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Media not found")

    thumb_file, _ = db.thumb_paths(media_id)
    if thumb_file.is_file():
        return FileResponse(
            thumb_file,
            media_type="image/webp",
            headers={
                "Cache-Control": "private, max-age=31536000, immutable",
                # Cross-Origin-Resource-Policy: Chrome's ORB blocks cross-origin
                # image responses that lack it, which surfaced as
                # ERR_BLOCKED_BY_ORB and a "Preview unavailable" tile.
                "Cross-Origin-Resource-Policy": "cross-origin",
            },
        )

    # Not generated yet: queue it if it was never queued, and serve the
    # original so the tile still renders.
    try:
        if row["thumb_state"] in ("pending", "failed"):
            db.enqueue_thumbnail_job(media_id)
    except Exception:
        pass

    path = db.resolve_local_path(row["local_path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="The preview file is missing")
    return FileResponse(
        path,
        media_type=row["mime_type"],
        headers={"Cache-Control": "private, max-age=60"},
    )


@app.get("/api/media/{media_id}/micro-thumbnail")
def media_micro_thumbnail(
    media_id: str,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
):
    """Tiny blurred placeholder for progressive tile loading."""

    client_id = resolve_client_id(client_id, query_client_id)
    effective_client_id = client_id
    row = db.get_media(media_id, effective_client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Media not found")
    _, micro_file = db.thumb_paths(media_id)
    if not micro_file.is_file():
        raise HTTPException(status_code=404, detail="No blurred placeholder yet")
    return FileResponse(
        micro_file,
        media_type="image/webp",
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "Cross-Origin-Resource-Policy": "cross-origin",
        },
    )


@app.post("/api/thumbnails/backfill")
def thumbnails_backfill(client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    """Queue every asset that has no thumbnail yet."""

    client_id = resolve_client_id(client_id)
    return {"queued": db.enqueue_all_thumbnails(client_id)}


@app.get("/api/thumbnails/status")
def thumbnails_status(request: Request, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    client_id = resolve_client_id(client_id)
    return {**thumbnail_service(request).status(), **db.thumbnail_job_stats(client_id)}


@app.get("/api/media/{media_id}/content")
def media_content(
    media_id: str,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> FileResponse:
    # <video> and download anchors cannot set headers, so the query param is a
    # normal path here. The header-only call raised 400 before this ran.
    effective_client_id = resolve_client_id(client_id, query_client_id)
    row = db.get_media(media_id, effective_client_id)
    if not row:
        raise HTTPException(status_code=404, detail="Media not found")
    path = db.resolve_local_path(row["local_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Media preview is no longer available")
    return FileResponse(path, media_type=row["mime_type"], filename=row["original_name"], content_disposition_type="inline")


@app.get("/api/media/{media_id}/proxy")
def media_proxy(
    media_id: str,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> FileResponse:
    """Serve the small seek-friendly video proxy.

    Loaded straight into a <video>, so ?client_id= is required: the browser
    cannot attach a header to a media request.

    FileResponse answers range requests itself, so scrubbing works and the
    browser only buffers what it plays.
    """
    effective_client_id = resolve_client_id(client_id, query_client_id)
    row = db.get_media(media_id, effective_client_id)
    if not row or row["media_type"] != "video":
        raise HTTPException(status_code=404, detail="Not a video")
    if not db.proxy_ready(media_id):
        # A proxy can be gone because it was deleted by hand or the cache was
        # cleared, while the row still claims 'ready'. Re-queue it rather than
        # 404 forever, so the next play heals the library instead of needing the
        # Utilities button. The caller still gets a 404 for this request: there
        # is nothing to stream yet.
        row_state = row["proxy_state"]
        if row_state == "ready" and row["file_state"] == "present":
            try:
                db.enqueue_proxy_job(media_id)
            except Exception:
                pass
        raise HTTPException(status_code=404, detail="No proxy is ready for this video yet")
    return FileResponse(
        db.proxy_paths(media_id),
        media_type="video/mp4",
        content_disposition_type="inline",
        # A proxy is regenerated only when the row is re-imported, so it can be
        # cached aggressively while still allowing revalidation.
        headers={"Cache-Control": "private, max-age=86400"},
    )


@app.post("/api/videos/proxies")
def videos_enqueue_proxies(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict:
    """Queue a proxy for every video that does not have one yet."""
    effective_client_id = resolve_client_id(client_id, None)
    if not proxy_service.install_status()["available"]:
        raise HTTPException(status_code=503, detail="ffmpeg is not installed, so proxies cannot be built")
    queued = db.enqueue_all_proxies(effective_client_id)
    return {"queued": queued, **db.proxy_status(effective_client_id)}


@app.get("/api/videos/status")
def videos_status(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> dict:
    effective_client_id = resolve_client_id(client_id, query_client_id)
    return {**proxy_service.install_status(), **db.proxy_status(effective_client_id)}


@app.get("/api/media/{media_id}/telegram-content")
async def telegram_media_content(
    media_id: str,
    request: Request,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> FileResponse:
    # <video> and download anchors cannot set headers, so the query param is a
    # normal path here. The header-only call raised 400 before this ran.
    effective_client_id = resolve_client_id(client_id, query_client_id)
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
    # <video> and download anchors cannot set headers, so the query param is a
    # normal path here. The header-only call raised 400 before this ran.
    effective_client_id = resolve_client_id(client_id, query_client_id)
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
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict:
    client_id = resolve_client_id(client_id)
    if not db.retry_media(media_id, client_id):
        raise HTTPException(status_code=404, detail="Media not found")
    # Thumbnails are generated in the background for photos and videos alike.
    try:
        db.enqueue_thumbnail_job(media_id)
    except Exception:
        pass

    await telegram_service(request).enqueue(media_id)

    # The media type lives on the row, not in this scope: retry has no upload
    # form to read it from. Reading it here is why this route used to raise
    # NameError *after* the upload had already been queued, so the retry looked
    # like a 500 while quietly succeeding.
    row = db.get_media(media_id, client_id)
    media_type = row["media_type"] if row else None
    if media_type == "photo":
        try:
            db.enqueue_face_job(media_id, client_id)
        except Exception:
            pass
    elif media_type == "video":
        # A proxy is what makes playback start in a second rather than after a
        # full Telegram download, so queue it the moment a video arrives.
        try:
            db.enqueue_proxy_job(media_id)
        except Exception:
            pass
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
def faces_status(request: Request, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    client_id = resolve_client_id(client_id)
    service = face_service(request)
    return {**service.status(), **db.face_job_stats(client_id)}


@app.post("/api/faces/scan")
def faces_scan(request: Request, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    """Queue every photo that has not been analysed yet."""

    client_id = resolve_client_id(client_id)
    service = face_service(request)
    if not service.available and service.load_error:
        raise HTTPException(status_code=503, detail=service.load_error)
    queued = db.enqueue_all_photos(client_id)
    return {"queued": queued}


@app.post("/api/faces/cluster")
async def faces_cluster(request: Request, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    """Group unassigned faces into people."""

    client_id = resolve_client_id(client_id)
    service = face_service(request)
    try:
        return await service.cluster(client_id)
    except FaceUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/people")
def get_people(client_id: str | None = Header(default=None, alias="X-Client-ID")) -> list[dict]:
    client_id = resolve_client_id(client_id)
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
def person_media(person_id: str, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> list[dict]:
    client_id = resolve_client_id(client_id)
    return [db.row_to_media(row) for row in db.list_media_by_person(client_id, person_id)]


@app.patch("/api/people/{person_id}")
def rename_person(person_id: str, payload: PersonRename, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    client_id = resolve_client_id(client_id)
    name = (payload.name or "").strip()[:100] or None
    row = db.set_person_name(person_id, client_id, name)
    if not row:
        raise HTTPException(status_code=404, detail="Person not found")
    return {"id": row["id"], "name": row["name"], "face_count": row["face_count"]}


@app.post("/api/people/merge")
def merge_people(payload: PersonMerge, client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    client_id = resolve_client_id(client_id)
    if payload.source_id == payload.target_id:
        raise HTTPException(status_code=400, detail="Choose two different people to merge")
    moved = db.merge_people(payload.source_id, payload.target_id, client_id)
    if not moved:
        raise HTTPException(status_code=404, detail="One of those people was not found")
    return {"merged_faces": moved}


@app.post("/api/integrity/check")
async def integrity_check(
    request: Request,
    limit: int = Query(default=500, ge=1, le=5000),
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
) -> dict:
    """Verify that backed-up originals still exist in Telegram."""

    client_id = resolve_client_id(client_id)
    try:
        return await telegram_service(request).check_integrity(client_id, limit=limit)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/geo/backfill")
def geo_backfill(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    limit: int = Query(default=500, ge=1, le=5000),
) -> dict:
    """Read GPS out of local originals uploaded before locations were captured.

    Only touches rows whose local copy is present; a photo whose file is gone
    is skipped rather than guessed at.
    """
    client_id = resolve_client_id(client_id)
    candidates = db.photos_missing_gps(client_id)[:limit]
    found = 0
    checked = 0
    for row in candidates:
        path = db.resolve_local_path(row["local_path"])
        if not path or not path.is_file():
            continue
        checked += 1
        coordinates = read_image_coordinates(path)
        if not coordinates:
            continue
        latitude, longitude = coordinates
        db.set_media_coordinates(row["id"], latitude, longitude)
        found += 1
    # Report what is genuinely left, not an estimate of the batch.
    remaining = len(db.photos_missing_gps(client_id))
    return {"checked": checked, "located": found, "remaining": remaining}


@app.get("/api/geo/points")
def geo_points(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> list[dict]:
    """Photos with a location, newest first."""
    client_id = resolve_client_id(client_id, query_client_id)
    return [
        {
            "id": row["id"],
            "name": row["original_name"],
            "captured_at": row["capture_time"],
            "latitude": row["latitude"],
            "longitude": row["longitude"],
            "thumb_ready": row["thumb_state"] == "ready",
            "preview_url": f"/api/media/{row['id']}/thumbnail",
        }
        for row in db.geotagged_points(client_id)
    ]


@app.post("/api/cameras/backfill")
def cameras_backfill(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    limit: int = Query(default=500, ge=1, le=5000),
) -> dict:
    """Read camera make/model out of local originals uploaded before capture."""
    client_id = resolve_client_id(client_id, query_client_id=None)
    candidates = db.photos_missing_camera(client_id)[:limit]
    found = 0
    for row in candidates:
        path = db.resolve_local_path(row["local_path"])
        if not path or not path.is_file():
            continue
        make, model, lens = read_image_camera(path)
        if not (make or model or lens):
            continue
        db.set_media_camera(row["id"], make, model, lens)
        found += 1
    return {"checked": len(candidates), "labeled": found, "remaining": len(db.photos_missing_camera(client_id))}


@app.get("/api/cameras")
def cameras(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> list[dict]:
    """Cameras present in the library, most-used first."""
    return db.camera_options(resolve_client_id(client_id, query_client_id))


@app.get("/api/utilities/large-files")
def utilities_large_files(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    limit: int = Query(default=20, ge=1, le=100),
) -> dict:
    """Biggest originals, and the library total for context."""
    effective = resolve_client_id(client_id, None)
    result = db.largest_media(effective, limit)
    return {
        "total_bytes": result["total_bytes"],
        "min_bytes": result["min_bytes"],
        "items": [db.row_to_media(row) for row in result["items"]],
    }


@app.get("/api/utilities/location-gaps")
def utilities_location_gaps(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> dict:
    return db.location_gaps(resolve_client_id(client_id, query_client_id))


@app.post("/api/duplicates/resolve")
def duplicates_resolve(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    checksum: str = Query(...),
) -> dict:
    """Resolve one duplicate group by trashing the extra copies.

    Trash rather than delete so this is reversible: the rows move to the Trash
    view. The oldest copy is kept.
    """
    effective = resolve_client_id(client_id, None)
    trashed = db.trash_duplicate_extras(effective, checksum)
    return {"trashed": trashed, "remaining": len(db.duplicate_groups(effective))}


@app.get("/api/explore/places")
def explore_places(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> list[dict]:
    """Approximate photo areas. Not cities: see db.place_groups."""
    return db.place_groups(resolve_client_id(client_id, query_client_id))


@app.get("/api/explore/tags")
def explore_tags(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> list[dict]:
    return db.tag_groups(resolve_client_id(client_id, query_client_id))


@app.get("/api/explore/people")
def explore_people(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> list[dict]:
    return db.person_groups(resolve_client_id(client_id, query_client_id))


@app.get("/api/duplicates")
def duplicates(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> list[dict]:
    """Media stored more than once, reported but never auto-deleted."""
    return db.duplicate_groups(resolve_client_id(client_id, query_client_id))


@app.get("/api/memories")
def memories(
    month: int | None = Query(default=None, ge=1, le=12),
    day: int | None = Query(default=None, ge=1, le=31),
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> dict:
    """Photos from this day in earlier years."""
    client_id = resolve_client_id(client_id, query_client_id)
    today = datetime.now()
    rows = db.on_this_day(client_id, month or today.month, day or today.day)
    return {
        "month": month or today.month,
        "day": day or today.day,
        "items": [db.row_to_media(row) for row in rows],
    }


@app.get("/api/recently-added")
def recently_added(
    limit: int = Query(default=60, ge=1, le=500),
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> list[dict]:
    """Newest arrivals by library date, not capture date."""
    return [
        db.row_to_media(row)
        for row in db.recently_added(resolve_client_id(client_id, query_client_id), limit)
    ]


@app.get("/api/backup/status")
async def backup_status(
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> dict:
    """How far the local index has drifted from the last Telegram snapshot."""
    return db.backup_state(resolve_client_id(client_id, query_client_id))


@app.post("/api/backup/metadata")
async def backup_metadata(
    request: Request,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> dict:
    """Upload a JSON snapshot of the local index to Telegram."""
    resolved = resolve_client_id(client_id, query_client_id)
    try:
        return await telegram_service(request).backup_metadata(resolved)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/api/restore/scan")
async def restore_scan(
    request: Request,
    limit: int = Query(default=3000, ge=1, le=20000),
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> dict:
    """Inspect Saved Messages without changing anything.

    Reports both InfinityVault's own backups and any media saved to Telegram
    directly, because the second kind is a user's whole existing library and
    used to be skipped silently.
    """
    resolved = resolve_client_id(client_id, query_client_id)
    try:
        result = await telegram_service(request).scan_for_restore(resolved, limit=limit)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    # The per-item list can be large; the UI only needs the counts.
    return {
        "scanned": result["scanned"],
        "media_found": result["media_found"],
        "own_backups": result.get("own_backups", 0),
        "adoptable": result.get("adoptable", 0),
        "has_metadata_backup": result["has_metadata_backup"],
    }


@app.post("/api/restore/apply")
async def restore_apply(
    request: Request,
    limit: int = Query(default=3000, ge=1, le=20000),
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
) -> dict:
    """Rebuild the local index from Telegram. Idempotent, never deletes."""
    resolved = resolve_client_id(client_id, query_client_id)
    try:
        return await telegram_service(request).apply_restore(resolved, limit=limit)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/api/integrity/status")
def integrity_status(client_id: str | None = Header(default=None, alias="X-Client-ID")) -> dict:
    client_id = resolve_client_id(client_id)
    return db.integrity_summary(client_id)


@app.get("/api/integrity/broken")
def integrity_broken(client_id: str | None = Header(default=None, alias="X-Client-ID")) -> list[dict]:
    """Assets whose Telegram original is gone, so the UI can offer a re-upload."""

    client_id = resolve_client_id(client_id)
    return [db.row_to_media(row) for row in db.list_broken_media(client_id)]


@app.get("/api/faces/{face_id}/thumbnail")
def face_thumbnail(
    face_id: str,
    client_id: str | None = Header(default=None, alias="X-Client-ID"),
    query_client_id: str | None = Query(default=None, alias="client_id"),
):
    """Crop a single face from its original for the People grid.

    Rendered straight into an <img>, so it must accept ?client_id= -- the
    browser cannot attach a header to an image request.
    """

    client_id = resolve_client_id(client_id, query_client_id)
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

    image = cv2.imread(str(db.resolve_local_path(face["local_path"])))
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
