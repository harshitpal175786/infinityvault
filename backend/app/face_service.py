"""Optional face detection and embedding.

Design constraints, in order:

1. **Never break the app.** If InsightFace is not installed the rest of
   InfinityVault must keep working exactly as before. Every model import is
   lazy and every failure is reported as a status, not an exception.
2. **Lightweight.** One model pack, one worker thread, CPU by default.
   onnxruntime picks the best available provider at runtime so the same code
   runs on Apple Silicon (CoreML), CUDA, and a plain CPU-only laptop.
3. **Never block the event loop.** Inference is CPU-bound and slow, so it runs
   in a thread executor while the async worker awaits it.
"""

from __future__ import annotations

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import db

logger = logging.getLogger(__name__)

# buffalo_s is 159 MB and ~2x faster than buffalo_l with roughly 80% of the
# accuracy. buffalo_l (326 MB) is opt-in for people who want the best
# clustering on a capable machine.
DEFAULT_MODEL = os.getenv("INFINITYVAULT_FACE_MODEL", "buffalo_s")
DEFAULT_PROVIDER = os.getenv("INFINITYVAULT_FACE_PROVIDER", "auto")

# Face crops smaller than this are almost always false positives or too
# blurry to embed reliably.
MIN_FACE_PIXELS = int(os.getenv("INFINITYVAULT_FACE_MIN_PIXELS", "36"))

# Cosine similarity above which two faces are treated as the same person.
# 0.5 is a deliberately cautious default: under-merging is easy to fix in the
# UI, over-merging silently fuses two relatives into one person.
SIMILARITY_THRESHOLD = float(os.getenv("INFINITYVAULT_FACE_SIMILARITY", "0.5"))


class FaceUnavailable(RuntimeError):
    """Raised when the optional dependencies are not installed."""


class FaceService:
    def __init__(self) -> None:
        self._app = None
        self._load_error: str | None = None
        self._load_attempted = False
        self._executor: ThreadPoolExecutor | None = None
        self.worker_task: asyncio.Task[None] | None = None
        self._running = False

    # -- capability -------------------------------------------------------
    @property
    def available(self) -> bool:
        """True once the model has loaded successfully."""
        return self._app is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def status(self) -> dict:
        return {
            "available": self.available,
            "model": DEFAULT_MODEL,
            "error": self._load_error,
            "similarity_threshold": SIMILARITY_THRESHOLD,
        }

    def _ensure_model(self):
        """Load InsightFace once, lazily. Raises FaceUnavailable on any problem."""
        if self._app is not None:
            return self._app
        if self._load_attempted and self._load_error:
            raise FaceUnavailable(self._load_error)

        self._load_attempted = True
        try:
            import insightface  # noqa: PLC0415 - optional dependency
            from insightface.app import FaceAnalysis  # noqa: PLC0415
        except ImportError as exc:
            self._load_error = (
                "Face recognition dependencies are not installed. "
                "Run: backend/.venv/bin/pip install -r backend/requirements-faces.txt"
            )
            raise FaceUnavailable(self._load_error) from exc

        try:
            providers = self._providers()
            app = FaceAnalysis(name=DEFAULT_MODEL, providers=providers)
            # ctx_id 0 is the GPU id used by CoreML/CUDA; harmless on CPU.
            app.prepare(ctx_id=0, det_size=(640, 640))
        except Exception as exc:  # model download or provider failure
            # We still need numpy/opencv even if the model itself failed.
            self._load_error = f"Face model '{DEFAULT_MODEL}' could not load: {exc}"
            logger.warning(self._load_error)
            raise FaceUnavailable(self._load_error) from exc

        self._app = app
        logger.info("Face model '%s' ready (providers: %s)", DEFAULT_MODEL, providers)
        return app

    @staticmethod
    def _providers() -> list[str]:
        """Pick execution providers, newest-best first, CPU always last."""
        if DEFAULT_PROVIDER != "auto":
            return [DEFAULT_PROVIDER, "CPUExecutionProvider"]
        try:
            import onnxruntime as ort  # noqa: PLC0415
            available = set(ort.get_available_providers())
        except Exception:
            return ["CPUExecutionProvider"]
        for provider in ("CoreMLExecutionProvider", "CUDAExecutionProvider", "DmlExecutionProvider"):
            if provider in available:
                return [provider, "CPUExecutionProvider"]
        return ["CPUExecutionProvider"]

    # -- inference --------------------------------------------------------
    def _analyse_sync(self, image_path: str) -> list[dict]:
        """Blocking detect+embed for a single file. Runs in a thread."""
        # Import the optional stack behind one guard. numpy/opencv are only
        # installed alongside insightface, so importing them first would raise
        # a bare ModuleNotFoundError instead of the recoverable
        # FaceUnavailable the worker knows how to handle.
        try:
            import numpy as np  # noqa: PLC0415
            import cv2  # noqa: PLC0415
        except ImportError as exc:
            self._load_error = (
                "Face recognition dependencies are not installed. "
                "Run: backend/.venv/bin/pip install -r backend/requirements-faces.txt"
            )
            raise FaceUnavailable(self._load_error) from exc

        app = self._ensure_model()

        path = Path(image_path)
        if not path.exists():
            raise FileNotFoundError("The local image file is missing")

        # Downscale before detection: 640px is plenty for face boxes and is
        # dramatically faster than feeding a 12 MP original.
        image = cv2.imread(str(path))
        if image is None:
            raise ValueError("The image could not be decoded")

        height, width = image.shape[:2]
        scale = 1.0
        if max(height, width) > 1280:
            scale = 1280 / max(height, width)
            image = cv2.resize(image, (int(width * scale), int(height * scale)))

        results = []
        for face in app.get(image):
            x1, y1, x2, y2 = [float(v) for v in face.bbox]
            box_w, box_h = x2 - x1, y2 - y1
            if min(box_w, box_h) < MIN_FACE_PIXELS * scale:
                continue  # too small to be useful for clustering
            embedding = np.asarray(face.embedding, dtype=np.float32)
            norm = float(np.linalg.norm(embedding))
            if norm == 0:
                continue
            embedding = embedding / norm  # L2-normalise for cosine similarity
            results.append({
                # Store coordinates in original-image space.
                "bbox_x": x1 / scale,
                "bbox_y": y1 / scale,
                "bbox_w": box_w / scale,
                "bbox_h": box_h / scale,
                "det_score": float(face.det_score),
                "embedding": embedding.tobytes(),
                "embedding_dim": int(embedding.shape[0]),
            })
        return results

    async def analyse(self, image_path: str) -> list[dict]:
        if self._executor is None:
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="faces")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._analyse_sync, image_path)

    # -- lifecycle --------------------------------------------------------
    async def start(self) -> None:
        db.reset_interrupted_face_jobs()
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
        """Serial worker. One face at a time keeps 8 GB machines comfortable."""
        while self._running:
            try:
                job = await asyncio.to_thread(db.next_face_job)
                if not job:
                    await asyncio.sleep(3)
                    continue

                media_id = job["media_id"]
                await asyncio.to_thread(db.mark_face_job_running, media_id)
                try:
                    faces = await self.analyse(job["local_path"])
                except FaceUnavailable as exc:
                    # Missing deps must not spin: park the job with a reason.
                    await asyncio.to_thread(db.mark_face_job_failed, media_id, str(exc))
                    self._running = False
                    return
                except Exception as exc:
                    await asyncio.to_thread(db.mark_face_job_failed, media_id, f"Face analysis failed: {exc}")
                    continue

                await asyncio.to_thread(db.replace_faces_for_media, job["client_id"], media_id, faces)
                await asyncio.to_thread(db.mark_face_job_done, media_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Face worker error")
                await asyncio.sleep(3)

    # -- clustering -------------------------------------------------------
    async def cluster(self, client_id: str) -> dict:
        """Assign unassigned faces to people, then refresh person counts.

        Greedy incremental clustering: compare each face against the mean
        embedding of each known person. Simple, predictable, and fast enough
        for a personal library. A full re-cluster is a future improvement.
        """
        import numpy as np  # noqa: PLC0415

        faces = await asyncio.to_thread(db.list_unassigned_faces, client_id)
        if not faces:
            return {"assigned": 0, "created": 0}

        people = await asyncio.to_thread(db.list_people, client_id)
        centroids: list[tuple[str, np.ndarray]] = []
        for person in people:
            with db.closing(db.open_db()) as connection:
                rows = connection.execute(
                    "SELECT embedding FROM faces WHERE person_id = ?", (person["id"],)
                ).fetchall()
            if not rows:
                continue
            matrix = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
            centroid = matrix.mean(axis=0)
            norm = np.linalg.norm(centroid)
            if norm:
                centroids.append((person["id"], centroid / norm))

        assigned = 0
        created = 0
        for face in faces:
            vector = np.frombuffer(face["embedding"], dtype=np.float32)
            best_id, best_score = None, -1.0
            for person_id, centroid in centroids:
                score = float(np.dot(vector, centroid))
                if score > best_score:
                    best_id, best_score = person_id, score

            if best_id and best_score >= SIMILARITY_THRESHOLD:
                await asyncio.to_thread(db.assign_face_to_person, face["id"], best_id)
                assigned += 1
            else:
                person = await asyncio.to_thread(db.create_person, client_id, None, face["id"])
                await asyncio.to_thread(db.assign_face_to_person, face["id"], person["id"])
                centroids.append((person["id"], vector))
                created += 1

        return {"assigned": assigned, "created": created}
