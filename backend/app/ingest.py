"""Ingestion pipeline + processing queue.

A single worker thread drains a queue of file paths. For each file:
content-hash -> skip if unchanged -> extract (OCR if needed) -> classify ->
chunk -> embed -> store. Per-file progress ("OCR: page 3 of 12") is pushed to
a status structure the UI polls, so multi-minute jobs never look hung.
"""
from __future__ import annotations

import hashlib
import queue
import threading
import time
import traceback
from pathlib import Path
from typing import Dict, List, Optional

from . import db
from .chunking import make_chunks
from .classify import classify_document
from .extract import SUPPORTED_EXTS, UnsupportedFormatError, extract

_queue: "queue.Queue[str]" = queue.Queue()
_queued_paths = set()
_state_lock = threading.Lock()
_current: Optional[Dict] = None  # {path, filename, stage}
_worker_started = False


def file_hash(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# Folders that hold code assets, never user documents.
SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "build", "dist",
    "out", "target", ".idea", ".vscode", "assets", "res", "drawable", "mipmap",
    "icons", "img", "images", "static", "public", "ios", "android",
}

# Images smaller than this are icons/graphics, not scanned documents.
MIN_IMAGE_BYTES = 40 * 1024
MIN_IMAGE_DIM = 500

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}


# Filenames that typically hold credentials -- never index these, even though
# the store is local-only: a search index is the wrong place for secrets.
SENSITIVE_NAME_PARTS = (
    "recovery-code", "recovery_code", "backup-code", "backup_code",
    "password", "passwords", "secret", "secrets", "credential", "apikey",
    "api-key", "api_key", "private-key", "private_key", "2fa", "totp",
)


# Ubiquitous dev/config files that are never user paperwork.
DEV_FILENAMES = {
    "package.json", "package-lock.json", "tsconfig.json", "jsconfig.json",
    "composer.json", "manifest.json", "app.json", "angular.json", "launch.json",
    "settings.json", "tasks.json", "vercel.json", "firebase.json", "babel.config.json",
    "web.config", "pom.xml", "build.xml", "androidmanifest.xml", "strings.xml",
    "requirements.txt", "license.txt", "license.md", "changelog.md",
    "contributing.md", "code_of_conduct.md", "robots.txt", "cmakelists.txt",
    "contents.json", "info.plist", "gradle.properties", "proguard-rules.pro",
}


def _looks_like_document(p: Path) -> bool:
    name = p.name
    # Office lock files (~$foo.docx) and hidden/temp files.
    if name.startswith("~$") or name.startswith("."):
        return False
    lower = name.lower()
    if lower in DEV_FILENAMES:
        return False
    if any(part in lower for part in SENSITIVE_NAME_PARTS):
        return False
    if p.suffix.lower() not in SUPPORTED_EXTS:
        return False
    # Anything living inside a code/assets directory is not paperwork.
    parts = {part.lower() for part in p.parts[:-1]}
    if parts & SKIP_DIRS or any(part.lower().startswith(("mipmap-", "drawable-")) for part in p.parts):
        return False
    if p.suffix.lower() in IMAGE_EXTS:
        try:
            if p.stat().st_size < MIN_IMAGE_BYTES:
                return False
            from PIL import Image

            with Image.open(p) as img:
                if max(img.size) < MIN_IMAGE_DIM:
                    return False
        except OSError:
            return False
    return True


def enqueue_file(path: str) -> None:
    p = str(Path(path).resolve())
    if not _looks_like_document(Path(p)):
        return
    with _state_lock:
        if p in _queued_paths:
            return
        _queued_paths.add(p)
    _queue.put(p)


def enqueue_folder(folder: str) -> int:
    count = 0
    root = Path(folder)
    if not root.is_dir():
        return 0
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS:
            enqueue_file(str(p))
            count += 1
    return count


def queue_status() -> Dict:
    with _state_lock:
        return {
            "pending": _queue.qsize(),
            "current": dict(_current) if _current else None,
        }


def start_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    _worker_started = True
    threading.Thread(target=_worker_loop, name="ingest-worker", daemon=True).start()


def _set_stage(stage: str) -> None:
    with _state_lock:
        if _current is not None:
            _current["stage"] = stage


def _worker_loop() -> None:
    global _current
    while True:
        path = _queue.get()
        with _state_lock:
            _queued_paths.discard(path)
            _current = {"path": path, "filename": Path(path).name, "stage": "starting"}
        try:
            _process_file(path)
        except Exception:
            traceback.print_exc()
        finally:
            with _state_lock:
                _current = None
            _queue.task_done()


def _process_file(path: str) -> None:
    p = Path(path)
    if not p.exists():
        return
    # Debounce partially written files (a scanner app writing in chunks):
    # wait until the size is stable across two checks.
    last_size = -1
    for _ in range(30):
        try:
            size = p.stat().st_size
        except OSError:
            return
        if size == last_size and size > 0:
            break
        last_size = size
        time.sleep(0.5)

    _set_stage("hashing")
    try:
        chash = file_hash(path)
    except OSError:
        return

    doc_id, is_new = db.upsert_document(path, p.name, chash)
    if not is_new:
        doc = db.get_document(doc_id)
        if doc and doc["status"] == "ready":
            return  # same content already indexed (rename/move) -- skip
        if doc and doc["status"] == "removed":
            return  # user deleted it from the library -- stay deleted

    db.set_document_status(doc_id, "processing", "extracting text")
    try:
        _set_stage("extracting")
        result = extract(path, progress=lambda msg: (_set_stage(msg), db.set_document_status(doc_id, "processing", msg))[0])

        if not result.spans:
            if result.ocr_unavailable_pages > 0:
                db.set_document_status(
                    doc_id, "failed",
                    "Scanned document, but no OCR engine is installed "
                    "(pip install paddleocr, or install Tesseract).",
                )
            else:
                db.set_document_status(doc_id, "failed", "No extractable text found.")
            db.set_document_meta(doc_id, page_count=result.page_count, used_ocr=int(result.used_ocr))
            return

        _set_stage("classifying")
        doc = db.get_document(doc_id)
        if doc and doc["doc_type_source"] != "manual":
            db.set_document_meta(doc_id, doc_type=classify_document(result.spans, p.name))
        db.set_document_meta(doc_id, page_count=result.page_count, used_ocr=int(result.used_ocr))

        _set_stage("chunking")
        db.set_document_status(doc_id, "processing", "chunking")
        chunks = make_chunks(result.spans)
        if not chunks:
            db.set_document_status(doc_id, "failed", "Chunking produced no content.")
            return

        _set_stage(f"embedding {len(chunks)} chunks")
        db.set_document_status(doc_id, "processing", f"embedding {len(chunks)} chunks")
        from . import embeddings

        vecs = embeddings.embed_texts([c["text"] for c in chunks])

        _set_stage("storing")
        db.delete_chunks_for_document(doc_id)  # re-index on content change
        db.insert_chunks(doc_id, chunks, vecs)

        detail = ""
        if result.ocr_unavailable_pages:
            detail = f"{result.ocr_unavailable_pages} scanned page(s) skipped (no OCR engine)"
        db.set_document_status(doc_id, "ready", detail)
    except UnsupportedFormatError as e:
        # Expected condition with a user-facing message -- no traceback noise.
        db.set_document_status(doc_id, "failed", str(e))
    except Exception as e:
        db.set_document_status(doc_id, "failed", f"{type(e).__name__}: {e}")
        raise


def rescan_watched_folders(folders: List[str]) -> int:
    total = 0
    for f in folders:
        total += enqueue_folder(f)
    return total
