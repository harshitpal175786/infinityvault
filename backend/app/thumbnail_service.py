"""Thumbnail generation.

The grid used to download full-size originals to paint 180px tiles, which made
a dense library unusable. This service derives two small WebP files per asset,
once, and the UI then never touches the original for browsing.

Two sizes because they serve different jobs:

* ``_thumb.webp`` (400px longest edge) — the actual grid/viewer image.
  Full-width CSS pixels at 2x DPR is at most ~400px for a tile this size, so
  anything larger is wasted bytes.
* ``_micro.webp`` (32px, blurred) — inlined as a blur-up placeholder so tiles
  never flash empty while the real thumbnail decodes.

All work happens in a serial background worker, matching the upload and face
queues. Generation is never done in a request path.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import db

logger = logging.getLogger(__name__)

# Pillow is a hard dependency of this feature only. Importing lazily keeps the
# rest of the app working if it is somehow missing.
try:
    from PIL import Image  # noqa: F401  (presence check only)
    PIL_AVAILABLE = True
except ImportError:  # pragma: no cover - depends on install
    PIL_AVAILABLE = False

WEBP_QUALITY = 80
MICRO_QUALITY = 40
MICRO_BLUR = 2.0

# Video thumbnails grab a frame at this many seconds in. Frame 0 is often black.
VIDEO_SEEK_SECONDS = 1.0

FFMPEG_CANDIDATES = ("ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg")


def _find_ffmpeg() -> str | None:
    for candidate in FFMPEG_CANDIDATES:
        found = shutil.which(candidate) if "/" not in candidate else candidate
        if found and Path(found).is_file():
            return found
    return None


class ThumbnailService:
    def __init__(self) -> None:
        self.worker_task: asyncio.Task[None] | None = None
        self._running = False
        self._executor: ThreadPoolExecutor | None = None

    @property
    def available(self) -> bool:
        return PIL_AVAILABLE

    def status(self) -> dict:
        return {
            "available": PIL_AVAILABLE,
            "error": None if PIL_AVAILABLE else "Pillow is not installed; thumbnails are disabled.",
            "ffmpeg": bool(_find_ffmpeg()),
        }

    # -- generation -------------------------------------------------------
    def _generate_sync(self, media_id: str, local_path: str | None, media_type: str) -> str:
        """Create both WebP files. Runs in a thread; returns the error, if any."""
        from PIL import Image, ImageFilter  # noqa: PLC0415

        source = db.resolve_local_path(local_path)
        if not source.is_file():
            raise FileNotFoundError("The local original is missing")

        thumb_file, micro_file = db.thumb_paths(media_id)
        db.THUMB_DIR.mkdir(parents=True, exist_ok=True)

        frame_source = source
        extracted: Path | None = None
        if media_type == "video":
            ffmpeg = _find_ffmpeg()
            if not ffmpeg:
                raise RuntimeError("ffmpeg is required to thumbnail videos")
            extracted = db.THUMB_DIR / f"{media_id}_frame.jpg"
            subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error", "-ss", str(VIDEO_SEEK_SECONDS),
                 "-i", str(source), "-frames:v", "1", str(extracted)],
                check=True, timeout=60,
            )
            frame_source = extracted

        try:
            with Image.open(frame_source) as image:
                # Apply EXIF orientation, otherwise phone photos appear rotated.
                image = image.convert("RGB")
                try:
                    from PIL import ImageOps  # noqa: PLC0415
                    image = ImageOps.exif_transpose(image)
                except Exception:
                    pass

                thumb = image.copy()
                thumb.thumbnail((db.THUMB_LONGEST_EDGE,) * 2, Image.LANCZOS)
                thumb.save(thumb_file, "WEBP", quality=WEBP_QUALITY, method=4)

                micro = image.copy()
                micro.thumbnail((db.MICRO_LONGEST_EDGE,) * 2, Image.LANCZOS)
                micro = micro.filter(ImageFilter.GaussianBlur(MICRO_BLUR))
                micro.save(micro_file, "WEBP", quality=MICRO_QUALITY, method=4)
        finally:
            if extracted:
                extracted.unlink(missing_ok=True)

        return ""

    async def generate(self, media_id: str, local_path: str | None, media_type: str) -> None:
        if not PIL_AVAILABLE:
            raise RuntimeError("Pillow is not installed; thumbnails are disabled.")
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="thumbs")
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self._executor, self._generate_sync, media_id, local_path, media_type)

    # -- lifecycle --------------------------------------------------------
    async def start(self) -> None:
        db.reset_interrupted_thumbnail_jobs()
        self._running = True
        self.worker_task = asyncio.create_task(self._worker())

    async def stop(self) -> None:
        self._running = False
        if self.worker_task:
            self.worker_task.cancel()
            await asyncio.gather(self.worker_task, return_exceptions=True)
        if self._executor:
            self._executor.shutdown(wait=False)
            self._executor = None

    async def _worker(self) -> None:
        while self._running:
            try:
                job = await asyncio.to_thread(db.next_thumbnail_job)
                if not job:
                    await asyncio.sleep(3)
                    continue

                media_id = job["media_id"]
                await asyncio.to_thread(db.mark_thumbnail_running, media_id)
                try:
                    await self.generate(media_id, job["local_path"], job["media_type"])
                except Exception as exc:
                    # A failed thumbnail must never stall the queue; record it
                    # and move to the next item.
                    await asyncio.to_thread(db.mark_thumbnail_failed, media_id, str(exc))
                    continue

                await asyncio.to_thread(db.mark_thumbnail_done, media_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Thumbnail worker error")
                await asyncio.sleep(3)
