"""Video proxy generation.

Playing a video used to mean downloading the whole original from Telegram
before a single frame appeared. A five-minute 4K clip from a phone is hundreds
of megabytes, so the viewer sat on a spinner for minutes and scrubbing was
impossible until the download finished.

This service derives a small MP4 per video, once, so playback starts in
roughly a second and seeking works immediately. The original is never modified
or replaced: it stays the archival copy in Telegram, and "play original" remains
available for anyone who wants full quality.

Two ffmpeg flags matter more than the rest:

* ``-movflags +faststart`` moves the MP4 index to the front of the file. Without
  it the browser must download the whole file before it can seek, which defeats
  the point of having a proxy.
* ``-vf scale=...`` caps the long edge at 720px. Phone video is wildly
  over-specified for this screen, and re-encoding at 720p makes the file roughly
  an order of magnitude smaller.

Work happens in a serial background worker that is separate from the thumbnail
queue, so proxies can never delay a newly uploaded photo's thumbnail.
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

PROXY_LONG_EDGE = 720
PROXY_CRF = 26
PROXY_AUDIO_KBPS = 96
PROXY_TIMEOUT_SECONDS = 900

FFMPEG_CANDIDATES = ("ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg")


def find_ffmpeg() -> str | None:
    for candidate in FFMPEG_CANDIDATES:
        found = shutil.which(candidate) if "/" not in candidate else candidate
        if found and Path(found).is_file():
            return found
    return None


def _build_command(ffmpeg: str, source: Path, target: Path) -> list[str]:
    """Build the ffmpeg command for a seek-friendly 720p proxy.

    Scaling uses ``min`` on each axis so portrait video is capped on its long
    edge too, and ``force_original_aspect_ratio=decrease`` prevents a portrait
    clip from being stretched into a landscape frame. Both dimensions are
    rounded to even numbers because H.264 in yuv420p cannot encode odd sizes.
    """
    scale = (
        f"scale='if(gt(iw,ih),min({PROXY_LONG_EDGE},iw),-2)'"
        f":'if(gt(iw,ih),-2,min({PROXY_LONG_EDGE},ih))'"
    )
    return [
        ffmpeg,
        "-y",
        "-loglevel", "error",
        "-i", str(source),
        # Copy the colour metadata through; some phone clips are HDR and look
        # washed out without it.
        "-map_metadata", "0",
        "-vf", scale,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", str(PROXY_CRF),
        "-pix_fmt", "yuv420p",  # required for QuickTime and older Safari
        "-profile:v", "main",
        "-c:a", "aac",
        "-b:a", f"{PROXY_AUDIO_KBPS}k",
        "-ac", "2",
        "-movflags", "+faststart",
        str(target),
    ]


def install_status() -> dict:
    """Whether proxies can be built at all on this machine."""
    ffmpeg = find_ffmpeg()
    return {
        "available": bool(ffmpeg),
        "ffmpeg": ffmpeg,
        "error": None if ffmpeg else "ffmpeg is not installed; videos play their original.",
    }


class ProxyService:
    def __init__(self) -> None:
        self.worker_task: asyncio.Task[None] | None = None
        self._running = False
        self._executor: ThreadPoolExecutor | None = None

    @property
    def available(self) -> bool:
        return find_ffmpeg() is not None

    def status(self) -> dict:
        return install_status()

    # -- generation -------------------------------------------------------
    def _generate_sync(self, media_id: str, local_path: str | None) -> None:
        """Create the proxy. Runs in a thread."""
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            raise RuntimeError("ffmpeg is not installed")

        source = db.resolve_local_path(local_path)
        if not source.is_file():
            raise FileNotFoundError("The local original is missing")

        target = db.proxy_paths(media_id)
        db.PROXY_DIR.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(f"{target.stem}.part.mp4")

        try:
            result = subprocess.run(
                _build_command(ffmpeg, source, partial),
                capture_output=True,
                timeout=PROXY_TIMEOUT_SECONDS,
            )
            if result.returncode != 0:
                detail = (result.stderr or b"").decode("utf-8", "ignore").strip()
                raise RuntimeError(detail[-400:] or f"ffmpeg exited {result.returncode}")
            if not partial.is_file() or partial.stat().st_size == 0:
                raise RuntimeError("ffmpeg produced no output")
            partial.replace(target)
        finally:
            partial.unlink(missing_ok=True)

    async def ensure_worker(self) -> None:
        if self.worker_task and not self.worker_task.done():
            return
        if self._executor is None:
            # One thread: encoding a video already saturates a core, and this
            # machine must stay usable while it happens.
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="proxy")
        self._running = True
        self.worker_task = asyncio.create_task(self._run_loop())

    async def stop(self) -> None:
        self._running = False
        if self.worker_task:
            self.worker_task.cancel()
            try:
                await self.worker_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._executor:
            self._executor.shutdown(wait=False)
            self._executor = None

    async def _run_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while self._running:
            try:
                job = db.next_proxy_job()
                if not job:
                    await asyncio.sleep(3)
                    continue
                media_id = job["id"]
                try:
                    await loop.run_in_executor(
                        self._executor, self._generate_sync, media_id, job["local_path"]
                    )
                    db.mark_proxy_done(media_id)
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - must not kill the worker
                    logger.warning("proxy generation failed for %s: %s", media_id, error)
                    db.mark_proxy_failed(media_id, str(error))
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("proxy worker loop error")
                await asyncio.sleep(5)
