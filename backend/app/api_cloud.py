"""HTTP API for hosted multi-user DocBrain.

Every route is auth-gated (Depends(get_current_user)) and every db/storage
call is scoped by that user_id -- this is the actual per-user isolation
boundary, not just something the frontend happens to respect. CORS is locked
to the deployed frontend's origin (unlike api.py's wide-open "*", which is
only safe there because local mode binds to 127.0.0.1).
"""
from __future__ import annotations

import asyncio
import io
import os
from pathlib import Path
from typing import Any, Dict, List

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from . import db_cloud, ingest_cloud, retrieval_cloud, storage
from .auth import get_current_user
from .classify import DOC_TYPES
from .llm import LLMError, generate_answer

app = FastAPI(title="DocBrain Cloud")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ["ALLOWED_ORIGIN"]],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- status ------------------------------------------------------------------


@app.get("/api/status")
def status(user_id: str = Depends(get_current_user)) -> Dict[str, Any]:
    from . import embeddings, ocr

    corpus = db_cloud.corpus_stats(user_id)
    return {
        "queue": ingest_cloud.queue_status(user_id),
        "corpus": corpus,
        "privacy_mode": "Hosted (Gemini + Supabase)",
        "embedding_backend": embeddings.backend_name(),
        "ocr_engine": ocr.engine_name(),
        "onboarded": corpus["documents"] > 0,
    }


# --- documents -----------------------------------------------------------------


@app.get("/api/documents")
def documents(user_id: str = Depends(get_current_user)) -> List[Dict[str, Any]]:
    return db_cloud.list_documents(user_id)


@app.post("/api/documents/upload")
async def upload_documents(
    files: List[UploadFile] = File(...), user_id: str = Depends(get_current_user)
) -> Dict[str, Any]:
    doc_ids = []
    for f in files:
        data = await f.read()
        # submit_upload() does blocking I/O (Storage upload over httpx) --
        # run it off the event loop so one big upload can't stall every
        # other concurrent request.
        doc_id = await asyncio.to_thread(ingest_cloud.submit_upload, user_id, f.filename, data)
        doc_ids.append(doc_id)
    return {"document_ids": doc_ids}


class Retag(BaseModel):
    doc_type: str


@app.post("/api/documents/{doc_id}/retag")
def retag(doc_id: str, body: Retag, user_id: str = Depends(get_current_user)) -> Dict[str, Any]:
    if body.doc_type not in DOC_TYPES:
        raise HTTPException(400, f"doc_type must be one of {DOC_TYPES}")
    if not db_cloud.get_document(user_id, doc_id):
        raise HTTPException(404, "Document not found")
    db_cloud.set_document_meta(user_id, doc_id, doc_type=body.doc_type, doc_type_source="manual")
    return {"ok": True}


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str, user_id: str = Depends(get_current_user)) -> Dict[str, Any]:
    doc = db_cloud.get_document(user_id, doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    try:
        storage.remove(doc["storage_path"])
    except storage.StorageError:
        pass  # DB row removal still proceeds -- an orphaned blob isn't worth blocking on
    db_cloud.delete_document(user_id, doc_id)
    return {"ok": True}


@app.post("/api/documents/{doc_id}/reprocess")
def reprocess(doc_id: str, user_id: str = Depends(get_current_user)) -> Dict[str, Any]:
    if not db_cloud.get_document(user_id, doc_id):
        raise HTTPException(404, "Document not found")
    ingest_cloud.reprocess(user_id, doc_id)
    return {"ok": True}


IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}


@app.get("/api/documents/{doc_id}/page/{page}")
def page_image(
    doc_id: str, page: int, scale: float = 2.0, user_id: str = Depends(get_current_user)
) -> Response:
    doc = db_cloud.get_document(user_id, doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    ext = Path(doc["filename"]).suffix.lower()
    scale = max(0.5, min(scale, 4.0))

    try:
        data = storage.download(doc["storage_path"])
    except storage.StorageError:
        raise HTTPException(410, "Original file no longer exists in storage")

    if ext == ".pdf":
        import fitz

        pdf = fitz.open(stream=data, filetype="pdf")
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

        img = Image.open(io.BytesIO(data)).convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return Response(buf.getvalue(), media_type="image/png",
                        headers={"X-Page-Width": str(img.width), "X-Page-Height": str(img.height)})

    raise HTTPException(415, "Page rendering not supported for this file type (text-only citation shown instead)")


@app.get("/api/documents/{doc_id}/text")
def document_text(
    doc_id: str, page: int = 0, user_id: str = Depends(get_current_user)
) -> Dict[str, Any]:
    if not db_cloud.get_document(user_id, doc_id):
        raise HTTPException(404, "Document not found")
    text = db_cloud.get_document_text(user_id, doc_id, page)
    if text is None:
        raise HTTPException(404, "No text on this page")
    return {"text": text, "page": page}


@app.get("/api/chunks/{chunk_id}")
def chunk(chunk_id: str, user_id: str = Depends(get_current_user)) -> Dict[str, Any]:
    ch = db_cloud.get_chunk(user_id, chunk_id)
    if not ch:
        raise HTTPException(404, "Chunk not found")
    return ch


# --- ask ------------------------------------------------------------------------


class AskBody(BaseModel):
    question: str


@app.post("/api/ask")
def ask(body: AskBody, user_id: str = Depends(get_current_user)) -> Dict[str, Any]:
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "Empty question")

    file_hints = retrieval_cloud.filename_hints(question, db_cloud.list_documents(user_id))

    chunks = retrieval_cloud.retrieve(user_id, question)
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
