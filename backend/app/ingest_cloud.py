"""Upload-driven ingestion pipeline for hosted multi-user DocBrain.

Mirrors ingest.py::_process_file's stages exactly (hash -> extract -> classify
-> chunk -> embed -> store), but the source is uploaded bytes rather than a
watched filesystem path, and each stage is scoped to a user_id. Runs on a
small thread pool rather than ingest.py's single-worker queue, since multiple
users can upload concurrently and shouldn't be able to starve each other.
"""
from __future__ import annotations

import hashlib
import mimetypes
import tempfile
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, Optional

from . import db_cloud, storage
from .chunking import make_chunks
from .classify import classify_document
from .extract import UnsupportedFormatError, extract

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ingest-cloud")

_state_lock = threading.Lock()
# {user_id: {doc_id: {"filename": str, "stage": str}}}
_current: Dict[str, Dict[str, Dict[str, str]]] = {}


def _set_stage(user_id: str, doc_id: str, filename: str, stage: str) -> None:
    with _state_lock:
        _current.setdefault(user_id, {})[doc_id] = {"filename": filename, "stage": stage}


def _clear_stage(user_id: str, doc_id: str) -> None:
    with _state_lock:
        _current.get(user_id, {}).pop(doc_id, None)


def queue_status(user_id: str) -> Dict:
    with _state_lock:
        current = dict(_current.get(user_id, {}))
    return {"processing": list(current.values())}


def submit_upload(user_id: str, filename: str, data: bytes) -> str:
    """Saves to Storage, creates the document row, and schedules processing.
    Returns the document_id immediately; processing continues in the background."""
    content_hash = hashlib.sha256(data).hexdigest()
    ext = Path(filename).suffix.lower()
    storage_path = f"{user_id}/{content_hash}{ext}"

    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    storage.upload(storage_path, data, content_type)

    doc_id, is_new = db_cloud.upsert_document(user_id, storage_path, filename, content_hash)
    if not is_new:
        doc = db_cloud.get_document(user_id, doc_id)
        if doc and doc["status"] in ("ready", "removed"):
            return doc_id  # same content already indexed, or user deleted it -- stay as-is

    db_cloud.set_document_status(user_id, doc_id, "queued", "")
    _executor.submit(_process, user_id, doc_id, filename, storage_path, data)
    return doc_id


def _process(user_id: str, doc_id: str, filename: str, storage_path: str, data: bytes) -> None:
    ext = Path(filename).suffix.lower()
    db_cloud.set_document_status(user_id, doc_id, "processing", "extracting text")
    tmp_path: Optional[str] = None
    try:
        # extract() (PyMuPDF/python-docx/etc.) needs a real filesystem path --
        # bridge the uploaded bytes through a temp file for this process only.
        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        def progress(msg: str) -> None:
            _set_stage(user_id, doc_id, filename, msg)
            db_cloud.set_document_status(user_id, doc_id, "processing", msg)

        _set_stage(user_id, doc_id, filename, "extracting")
        result = extract(tmp_path, progress=progress)

        if not result.spans:
            if result.ocr_unavailable_pages > 0:
                db_cloud.set_document_status(
                    user_id, doc_id, "failed",
                    "Scanned document, but no OCR engine is installed.",
                )
            else:
                db_cloud.set_document_status(user_id, doc_id, "failed", "No extractable text found.")
            db_cloud.set_document_meta(
                user_id, doc_id, page_count=result.page_count, used_ocr=result.used_ocr
            )
            return

        _set_stage(user_id, doc_id, filename, "classifying")
        doc = db_cloud.get_document(user_id, doc_id)
        if doc and doc["doc_type_source"] != "manual":
            db_cloud.set_document_meta(user_id, doc_id, doc_type=classify_document(result.spans, filename))
        db_cloud.set_document_meta(
            user_id, doc_id, page_count=result.page_count, used_ocr=result.used_ocr
        )

        _set_stage(user_id, doc_id, filename, "chunking")
        db_cloud.set_document_status(user_id, doc_id, "processing", "chunking")
        chunks = make_chunks(result.spans)
        if not chunks:
            db_cloud.set_document_status(user_id, doc_id, "failed", "Chunking produced no content.")
            return

        _set_stage(user_id, doc_id, filename, f"embedding {len(chunks)} chunks")
        db_cloud.set_document_status(user_id, doc_id, "processing", f"embedding {len(chunks)} chunks")
        from . import embeddings

        vecs = embeddings.embed_texts([c["text"] for c in chunks])

        _set_stage(user_id, doc_id, filename, "storing")
        db_cloud.delete_chunks_for_document(user_id, doc_id)  # re-index on content change
        db_cloud.insert_chunks(user_id, doc_id, chunks, vecs)

        detail = ""
        if result.ocr_unavailable_pages:
            detail = f"{result.ocr_unavailable_pages} scanned page(s) skipped (no OCR engine)"
        db_cloud.set_document_status(user_id, doc_id, "ready", detail)
    except UnsupportedFormatError as e:
        db_cloud.set_document_status(user_id, doc_id, "failed", str(e))
    except Exception as e:
        db_cloud.set_document_status(user_id, doc_id, "failed", f"{type(e).__name__}: {e}")
        traceback.print_exc()
    finally:
        _clear_stage(user_id, doc_id)
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)


def reprocess(user_id: str, doc_id: str) -> None:
    doc = db_cloud.get_document(user_id, doc_id)
    if not doc:
        return
    data = storage.download(doc["storage_path"])
    db_cloud.set_document_status(user_id, doc_id, "queued", "")
    _executor.submit(_process, user_id, doc_id, doc["filename"], doc["storage_path"], data)
