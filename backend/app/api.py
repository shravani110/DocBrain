"""HTTP API for the desktop shell (Electron) frontend.

Binds to 127.0.0.1 only. All endpoints are local; nothing here is reachable
from the network.
"""
from __future__ import annotations

import io
import sys
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, db, ingest, retrieval, watcher
from .classify import DOC_TYPES
from .llm import LLMError, generate_answer

app = FastAPI(title="DocBrain")
# The server binds to 127.0.0.1 only, so a permissive CORS policy is safe and
# lets both the Vite dev server and the packaged Electron page (file://,
# which sends Origin: null) talk to it.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _static_cache_headers(request, call_next):
    """Vite fingerprints /assets/* filenames by content hash, so those can be
    cached forever. Everything else (index.html) must always revalidate --
    otherwise a rebuilt UI can silently keep serving stale JS from a browser
    or intermediate cache, as happened during development."""
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/assets/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif not path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.on_event("startup")
def _startup() -> None:
    db.get_conn()
    ingest.start_worker()
    settings = config.load_settings()
    folders = settings.get("watched_folders", [])
    watcher.set_watched_folders(folders)
    # Folder scans walk the whole tree; never block the event loop on them.
    threading.Thread(
        target=ingest.rescan_watched_folders, args=(folders,), daemon=True
    ).start()


# --- status / settings --------------------------------------------------------


@app.get("/api/status")
def status() -> Dict[str, Any]:
    from . import embeddings, ocr

    settings = config.load_settings()
    return {
        "queue": ingest.queue_status(),
        "corpus": db.corpus_stats(),
        "privacy_mode": config.privacy_mode(settings),
        "embedding_backend": embeddings.backend_name(),
        "ocr_engine": ocr.engine_name(),
        "onboarded": settings.get("onboarded", False),
    }


class SettingsUpdate(BaseModel):
    watched_folders: Optional[List[str]] = None
    llm_provider: Optional[str] = None
    llm_model: Optional[str] = None
    ollama_url: Optional[str] = None
    ollama_model: Optional[str] = None
    onboarded: Optional[bool] = None
    anthropic_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None


@app.get("/api/settings")
def get_settings() -> Dict[str, Any]:
    s = config.load_settings()
    s["has_anthropic_key"] = bool(config.get_api_key("anthropic"))
    s["has_openai_key"] = bool(config.get_api_key("openai"))
    return s


@app.post("/api/settings")
def update_settings(body: SettingsUpdate) -> Dict[str, Any]:
    updates = {k: v for k, v in body.dict().items()
               if v is not None and k not in ("anthropic_api_key", "openai_api_key")}
    if body.llm_provider is not None and body.llm_provider not in ("none", "local", "anthropic", "openai"):
        raise HTTPException(400, "Invalid llm_provider")
    if body.anthropic_api_key is not None:
        config.set_api_key("anthropic", body.anthropic_api_key or None)
    if body.openai_api_key is not None:
        config.set_api_key("openai", body.openai_api_key or None)
    merged = config.save_settings(updates)
    if body.watched_folders is not None:
        watcher.set_watched_folders(merged["watched_folders"])
        threading.Thread(
            target=ingest.rescan_watched_folders,
            args=(merged["watched_folders"],),
            daemon=True,
        ).start()
    merged["has_anthropic_key"] = bool(config.get_api_key("anthropic"))
    merged["has_openai_key"] = bool(config.get_api_key("openai"))
    return merged


# --- documents -----------------------------------------------------------------


@app.get("/api/documents")
def documents() -> List[Dict[str, Any]]:
    return db.list_documents()


class Retag(BaseModel):
    doc_type: str


@app.post("/api/documents/{doc_id}/retag")
def retag(doc_id: int, body: Retag) -> Dict[str, Any]:
    if body.doc_type not in DOC_TYPES:
        raise HTTPException(400, f"doc_type must be one of {DOC_TYPES}")
    if not db.get_document(doc_id):
        raise HTTPException(404, "Document not found")
    db.set_document_meta(doc_id, doc_type=body.doc_type, doc_type_source="manual")
    return {"ok": True}


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: int) -> Dict[str, Any]:
    """Remove a document from the index. The file on disk is untouched, and
    the content hash stays remembered so rescans don't re-add it."""
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    db.delete_chunks_for_document(doc_id)
    db.set_document_status(doc_id, "removed", "")
    return {"ok": True}


@app.post("/api/pick-folder")
def pick_folder() -> Dict[str, Any]:
    """Open the OS folder-picker dialog (runs in a subprocess so tkinter's
    main-thread requirement never conflicts with the server)."""
    import subprocess
    import sys

    script = (
        "import tkinter, tkinter.filedialog;"
        "r = tkinter.Tk(); r.withdraw(); r.attributes('-topmost', True);"
        "print(tkinter.filedialog.askdirectory() or '')"
    )
    try:
        out = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True, text=True, timeout=300,
        )
        path = out.stdout.strip()
    except (subprocess.TimeoutExpired, OSError):
        path = ""
    if not path:
        return {"path": None}
    # tkinter returns forward slashes everywhere; normalize to the native
    # separator (backslashes on Windows only).
    import os as _os

    return {"path": path.replace("/", "\\") if _os.name == "nt" else path}


@app.post("/api/documents/{doc_id}/reprocess")
def reprocess(doc_id: int) -> Dict[str, Any]:
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    db.set_document_status(doc_id, "queued", "")
    ingest.enqueue_file(doc["path"])
    return {"ok": True}


IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}


@app.get("/api/documents/{doc_id}/page/{page}")
def page_image(doc_id: int, page: int, scale: float = 2.0) -> Response:
    """Rendered page image + geometry headers for highlight scaling.

    X-Page-Width / X-Page-Height are in the same coordinate space as the
    stored chunk bounding boxes (PDF points for PDFs, pixels for images)."""
    doc = db.get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    path = Path(doc["path"])
    if not path.exists():
        raise HTTPException(410, "Original file no longer exists on disk")
    ext = path.suffix.lower()
    scale = max(0.5, min(scale, 4.0))

    if ext == ".pdf":
        import fitz

        pdf = fitz.open(str(path))
        try:
            if page < 0 or page >= pdf.page_count:
                raise HTTPException(404, "Page out of range")
            p = pdf[page]
            pix = p.get_pixmap(matrix=fitz.Matrix(scale, scale))
            png = pix.tobytes("png")
            w, h = p.rect.width, p.rect.height
        finally:
            pdf.close()
        return Response(png, media_type="image/png",
                        headers={"X-Page-Width": str(w), "X-Page-Height": str(h)})

    if ext in IMAGE_EXT:
        from PIL import Image

        img = Image.open(str(path)).convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return Response(buf.getvalue(), media_type="image/png",
                        headers={"X-Page-Width": str(img.width), "X-Page-Height": str(img.height)})

    raise HTTPException(415, "Page rendering not supported for this file type (text-only citation shown instead)")


@app.get("/api/documents/{doc_id}/text")
def document_text(doc_id: int, page: int = 0) -> Dict[str, Any]:
    """Extracted text of one page/slide -- the viewer's fallback for formats
    with no page image (docx/xlsx/pptx/txt/md/csv/html)."""
    if not db.get_document(doc_id):
        raise HTTPException(404, "Document not found")
    text = db.get_document_text(doc_id, page)
    if text is None:
        raise HTTPException(404, "No text on this page")
    return {"text": text, "page": page}


@app.get("/api/chunks/{chunk_id}")
def chunk(chunk_id: int) -> Dict[str, Any]:
    ch = db.get_chunk(chunk_id)
    if not ch:
        raise HTTPException(404, "Chunk not found")
    return ch


# --- folders (watched) -----------------------------------------------------------


class FolderBody(BaseModel):
    path: str

    def clean_path(self) -> str:
        # Tolerate quotes from Explorer's "Copy as path" and stray whitespace.
        return self.path.strip().strip('"').strip("'").strip()


@app.post("/api/folders")
def add_folder(body: FolderBody) -> Dict[str, Any]:
    p = Path(body.clean_path())
    if not p.is_dir():
        raise HTTPException(400, f"Not a folder: {body.clean_path()}")
    s = config.load_settings()
    folders = list(dict.fromkeys(s["watched_folders"] + [str(p.resolve())]))
    merged = config.save_settings({"watched_folders": folders})
    watcher.set_watched_folders(folders)
    threading.Thread(
        target=ingest.enqueue_folder, args=(str(p.resolve()),), daemon=True
    ).start()
    # Scan happens in the background; the header queue indicator shows progress.
    return {"watched_folders": merged["watched_folders"], "queued": None}


@app.delete("/api/folders")
def remove_folder(body: FolderBody) -> Dict[str, Any]:
    s = config.load_settings()
    folders = [f for f in s["watched_folders"] if f != body.clean_path()]
    merged = config.save_settings({"watched_folders": folders})
    watcher.set_watched_folders(folders)
    return {"watched_folders": merged["watched_folders"]}


# --- ask ------------------------------------------------------------------------


class AskBody(BaseModel):
    question: str


@app.post("/api/ask")
def ask(body: AskBody) -> Dict[str, Any]:
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "Empty question")

    # Files with no searchable text (e.g. a photo OCR couldn't read) can
    # never surface through content retrieval below; if the filename matches
    # the question, flag it explicitly rather than silently omitting it or
    # (worse) answering from an unrelated document that happens to share a
    # word with the filename.
    file_hints = retrieval.filename_hints(question, db.list_documents())

    chunks = retrieval.retrieve(question)
    if not chunks:
        return {
            "answer": "No clear answer found in your documents.",
            "citations": [],
            "sources": [],
            "no_answer": True,
            "found_in_documents": 0,
            "file_hints": file_hints,
        }

    try:
        result = generate_answer(question, chunks)
    except LLMError as e:
        # Retrieval-only degradation: show the top passages, clearly labeled.
        return {
            "answer": None,
            "llm_error": str(e),
            "citations": [],
            "no_answer": False,
            "found_in_documents": len({c["document_id"] for c in chunks}),
            "retrieved_passages": [_passage(c) for c in chunks[:4]],
            "sources": _sources(chunks[:4]),
            "file_hints": file_hints,
        }

    cited_ids = {c["chunk_id"] for c in result["citations"]}
    cited_chunks = [c for c in chunks if c["id"] in cited_ids]
    chunk_by_id = {c["id"]: c for c in chunks}

    citations = []
    for cit in result["citations"]:
        ch = chunk_by_id.get(cit["chunk_id"])
        if not ch:
            continue
        citations.append({
            "chunk_id": cit["chunk_id"],
            "quoted_span": cit["quoted_span"],
            "document_id": ch["document_id"],
            "filename": ch["filename"],
            "page_number": ch["page_number"],
            "doc_type": ch["doc_type"],
            "bboxes": ch["bboxes"],
            "section_heading": ch.get("section_heading", ""),
        })

    return {
        "answer": result["answer"],
        "citations": citations,
        "sources": _sources(cited_chunks),
        "no_answer": result["no_answer"],
        "found_in_documents": len({c["document_id"] for c in cited_chunks}),
        "provider": result["provider"],
        "model": result["model"],
        "file_hints": file_hints,
    }


def _passage(c: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "chunk_id": c["id"],
        "text": c["text"][:600],
        "filename": c["filename"],
        "document_id": c["document_id"],
        "page_number": c["page_number"],
        "bboxes": c["bboxes"],
    }


def _sources(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen, out = set(), []
    for c in chunks:
        if c["document_id"] in seen:
            continue
        seen.add(c["document_id"])
        out.append({
            "document_id": c["document_id"],
            "filename": c["filename"],
            "doc_type": c["doc_type"],
        })
    return out


# --- built-in UI ------------------------------------------------------------
# Serve the built frontend so the whole app is one process at one URL.
# Mounted last so /api routes always win.
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    # Running as a PyInstaller-bundled executable: files are extracted under
    # sys._MEIPASS instead of living next to this source file.
    _ui_dist = Path(sys._MEIPASS) / "frontend_dist"
else:
    _ui_dist = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if _ui_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_ui_dist), html=True), name="ui")
