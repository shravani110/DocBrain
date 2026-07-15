"""Firestore storage for hosted multi-user DocBrain.

Mirrors backend/app/db.py's shape (the local single-user SQLite schema this
is modeled on) and backend/app/db_cloud.py's earlier Postgres/pgvector
version, but rebuilt for Firestore's actual constraints -- verified live,
not assumed, before writing this:
  - No cross-collection joins: chunks carry a DENORMALIZED copy of their
    parent document's `status`/`doc_type` (as `document_status`/`doc_type`),
    kept in sync by set_document_status()/set_document_meta() whenever the
    parent changes. This is what lets keyword/vector search filter on
    "ready" documents without a join.
  - No arrays-of-arrays: each bbox (itself a small array) is wrapped in a
    map ({"b": [...]}) before storage and unwrapped on read. This wrapping
    is entirely internal to this module.
  - No free-tier full-text search: keyword_search() uses a precomputed
    `keywords` array field + array_contains_any (Firestore's 30-value cap
    per query, batched), then scores by term-overlap in Python.
  - Only ONE documented-safe prefilter for find_nearest() (the equality
    filter this module uses, on user_id) -- document_status/doc_type
    filtering for vector_search happens in Python on an over-fetched result
    set rather than gambling on unverified multi-filter query-planner
    behavior.

Uses the filter=FieldFilter(...) form of .where() throughout (not the
positional .where(field, op, value) form, which still works but emits a
UserWarning in the installed client version -- verified directly against
the real package source, not assumed).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from google.cloud.firestore_v1.vector import Vector
from google.cloud.firestore_v1.base_vector_query import DistanceMeasure

from .firebase_app import get_firestore_client

_NOT_REMOVED = ["queued", "processing", "ready", "failed"]
_ARRAY_CONTAINS_ANY_LIMIT = 30
_VECTOR_OVERFETCH = 4  # find_nearest only prefilters on user_id server-side;
# document_status/doc_types are filtered in Python after fetching, so ask
# Firestore for more candidates than we need to preserve recall.

_db: Optional[firestore.Client] = None


def _client() -> firestore.Client:
    global _db
    if _db is None:
        _db = get_firestore_client()
    return _db


def _documents_col():
    return _client().collection("documents")


def _chunks_col():
    return _client().collection("chunks")


def _wrap_bboxes(bboxes: Optional[List[list]]) -> List[Dict[str, list]]:
    return [{"b": b} for b in (bboxes or [])]


def _unwrap_bboxes(bboxes: Optional[List[Dict[str, list]]]) -> List[list]:
    return [b["b"] for b in (bboxes or [])]


_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _keyword_tokens(text: str) -> List[str]:
    """Precomputed for the `keywords` array field -- deliberately NOT
    retrieval.py's _tokenize(), which drops sub-3-char tokens and is tuned
    for fuzzy filename-hint matching, not general keyword indexing (would
    make short-but-meaningful terms like "vat" or "q1" unsearchable)."""
    return sorted(set(_TOKEN_RE.findall(text.lower())))


def _query_tokens(query: str) -> List[str]:
    return sorted(set(_TOKEN_RE.findall(query.lower())))


def _doc_to_dict(snap) -> Dict[str, Any]:
    d = snap.to_dict() or {}
    d["id"] = snap.id
    return d


# --- documents ---------------------------------------------------------------


def upsert_document(user_id: str, storage_path: str, filename: str, content_hash: str) -> Tuple[str, bool]:
    """Returns (document_id, is_new_content). Mirrors the Postgres version --
    a 'removed' document is not resurrected by re-uploading identical content."""
    col = _documents_col()
    existing = list(
        col.where(filter=FieldFilter("user_id", "==", user_id))
        .where(filter=FieldFilter("content_hash", "==", content_hash))
        .limit(1)
        .stream()
    )
    if existing:
        snap = existing[0]
        snap.reference.update({"storage_path": storage_path, "filename": filename})
        return snap.id, False

    ref = col.document()
    ref.set({
        "user_id": user_id,
        "storage_path": storage_path,
        "filename": filename,
        "content_hash": content_hash,
        "doc_type": "other",
        "doc_type_source": "auto",
        "page_count": 0,
        "status": "queued",
        "status_detail": "",
        "used_ocr": False,
        "added_at": firestore.SERVER_TIMESTAMP,
        "processed_at": None,
    })
    return ref.id, True


def _propagate_to_chunks(doc_id: str, user_id: str, fields: Dict[str, Any]) -> None:
    """No cross-collection joins in Firestore -- chunks carry their own copy
    of these fields so search queries can filter without a join."""
    chunks = list(
        _chunks_col()
        .where(filter=FieldFilter("document_id", "==", doc_id))
        .where(filter=FieldFilter("user_id", "==", user_id))
        .stream()
    )
    if not chunks:
        return
    bw = _client().bulk_writer()
    for c in chunks:
        bw.update(c.reference, fields)
    bw.close()


def set_document_status(user_id: str, doc_id: str, status: str, detail: str = "") -> None:
    ref = _documents_col().document(doc_id)
    snap = ref.get()
    if not snap.exists or snap.get("user_id") != user_id:
        return
    updates: Dict[str, Any] = {"status": status, "status_detail": detail}
    if status == "ready":
        updates["processed_at"] = firestore.SERVER_TIMESTAMP
    ref.update(updates)
    _propagate_to_chunks(doc_id, user_id, {"document_status": status})


def set_document_meta(user_id: str, doc_id: str, **fields: Any) -> None:
    allowed = {"doc_type", "doc_type_source", "page_count", "used_ocr"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return
    ref = _documents_col().document(doc_id)
    snap = ref.get()
    if not snap.exists or snap.get("user_id") != user_id:
        return
    ref.update(sets)
    if "doc_type" in sets:
        _propagate_to_chunks(doc_id, user_id, {"doc_type": sets["doc_type"]})


def get_document(user_id: str, doc_id: str) -> Optional[Dict[str, Any]]:
    snap = _documents_col().document(doc_id).get()
    if not snap.exists or snap.get("user_id") != user_id:
        return None
    return _doc_to_dict(snap)


def list_documents(user_id: str) -> List[Dict[str, Any]]:
    q = (
        _documents_col()
        .where(filter=FieldFilter("user_id", "==", user_id))
        .where(filter=FieldFilter("status", "in", _NOT_REMOVED))  # "in" avoids the extra
        .order_by("added_at", direction=firestore.Query.DESCENDING)  # ordering constraint != imposes
    )
    return [_doc_to_dict(s) for s in q.stream()]


def delete_chunks_for_document(user_id: str, doc_id: str) -> None:
    chunks = list(
        _chunks_col()
        .where(filter=FieldFilter("document_id", "==", doc_id))
        .where(filter=FieldFilter("user_id", "==", user_id))
        .stream()
    )
    if not chunks:
        return
    bw = _client().bulk_writer()
    for c in chunks:
        bw.delete(c.reference)
    bw.close()


def delete_document(user_id: str, doc_id: str) -> None:
    """Hard delete -- Firestore has no FK cascade, so chunks are removed
    explicitly first. Caller removes the Storage object separately."""
    ref = _documents_col().document(doc_id)
    snap = ref.get()
    if not snap.exists or snap.get("user_id") != user_id:
        return
    delete_chunks_for_document(user_id, doc_id)
    ref.delete()


# --- chunks ------------------------------------------------------------------


def insert_chunks(user_id: str, doc_id: str, chunks: List[Dict[str, Any]], embeddings: Optional[np.ndarray]) -> None:
    doc_snap = _documents_col().document(doc_id).get()
    doc_status = doc_snap.get("status") if doc_snap.exists else "processing"
    doc_type = doc_snap.get("doc_type") if doc_snap.exists else "other"

    bw = _client().bulk_writer()
    for i, ch in enumerate(chunks):
        vec = None
        if embeddings is not None:
            vec = Vector(np.asarray(embeddings[i], dtype=np.float32).tolist())
        ref = _chunks_col().document()
        bw.create(ref, {
            "document_id": doc_id,
            "user_id": user_id,
            "chunk_index": i,
            "text": ch["text"],
            "page_number": ch["page_number"],
            "bboxes": _wrap_bboxes(ch.get("bboxes", [])),
            "section_heading": ch.get("section_heading", ""),
            "embedding": vec,
            "keywords": _keyword_tokens(ch["text"]),
            "document_status": doc_status,
            "doc_type": doc_type,
        })
    bw.close()


def get_chunk(user_id: str, chunk_id: str) -> Optional[Dict[str, Any]]:
    snap = _chunks_col().document(str(chunk_id)).get()
    if not snap.exists or snap.get("user_id") != user_id:
        return None
    d = _doc_to_dict(snap)
    d["bboxes"] = _unwrap_bboxes(d.get("bboxes"))
    d.pop("embedding", None)
    d.pop("keywords", None)

    doc_snap = _documents_col().document(d["document_id"]).get()
    if doc_snap.exists:
        d["filename"] = doc_snap.get("filename")
        d["storage_path"] = doc_snap.get("storage_path")
        d["doc_type"] = doc_snap.get("doc_type")  # fresher than the denormalized copy
    return d


# --- search ------------------------------------------------------------------


def keyword_search(user_id: str, query: str, limit: int = 20, doc_types: Optional[List[str]] = None) -> List[Tuple[str, float]]:
    """array_contains_any over a precomputed keywords field (batched at
    Firestore's 30-value cap), scored by term-overlap in Python. Returns
    [(chunk_id, score)] with higher = better."""
    terms = _query_tokens(query)
    if not terms:
        return []

    scores: Dict[str, float] = {}
    doc_type_by_id: Dict[str, str] = {}
    query_terms = set(terms)
    for i in range(0, len(terms), _ARRAY_CONTAINS_ANY_LIMIT):
        batch = terms[i:i + _ARRAY_CONTAINS_ANY_LIMIT]
        q = (
            _chunks_col()
            .where(filter=FieldFilter("user_id", "==", user_id))
            .where(filter=FieldFilter("document_status", "==", "ready"))
            .where(filter=FieldFilter("keywords", "array_contains_any", batch))
        )
        for snap in q.stream():
            data = snap.to_dict() or {}
            overlap = len(query_terms & set(data.get("keywords", [])))
            if overlap == 0:
                continue
            scores[snap.id] = max(scores.get(snap.id, 0.0), float(overlap))
            doc_type_by_id[snap.id] = data.get("doc_type", "other")

    if doc_types:
        allowed = set(doc_types)
        scores = {cid: s for cid, s in scores.items() if doc_type_by_id.get(cid) in allowed}

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])[:limit]
    return ranked


def vector_search(user_id: str, query_vec: np.ndarray, limit: int = 20, doc_types: Optional[List[str]] = None) -> List[Tuple[str, float]]:
    """find_nearest() with only the documented-safe user_id prefilter
    server-side; document_status/doc_types are filtered in Python on an
    over-fetched result set. Score = cosine similarity, computed here from
    the raw vectors (Vector is a collections.abc.Sequence -- np.asarray()
    consumes it directly, verified against the real class source) rather
    than relying on find_nearest's distance_result_field parameter. Returns
    [(chunk_id, score)] with higher = better."""
    q = np.asarray(query_vec, dtype=np.float32)
    qn = q / (np.linalg.norm(q) + 1e-9)

    query = (
        _chunks_col()
        .where(filter=FieldFilter("user_id", "==", user_id))
        .find_nearest(
            vector_field="embedding",
            query_vector=Vector(q.tolist()),
            distance_measure=DistanceMeasure.COSINE,
            limit=limit * _VECTOR_OVERFETCH,
        )
    )

    results = []
    for snap in query.stream():
        data = snap.to_dict() or {}
        if data.get("document_status") != "ready":
            continue
        if doc_types and data.get("doc_type") not in doc_types:
            continue
        vec = data.get("embedding")
        if vec is None:
            continue
        mat = np.asarray(vec, dtype=np.float32)
        mn = mat / (np.linalg.norm(mat) + 1e-9)
        score = float(np.dot(mn, qn))
        results.append((snap.id, score))

    results.sort(key=lambda kv: -kv[1])
    return results[:limit]


def get_document_text(user_id: str, doc_id: str, page: int) -> Optional[str]:
    q = (
        _chunks_col()
        .where(filter=FieldFilter("document_id", "==", doc_id))
        .where(filter=FieldFilter("user_id", "==", user_id))
        .where(filter=FieldFilter("page_number", "==", page))
        .order_by("chunk_index")
    )
    rows = [s.to_dict() or {} for s in q.stream()]
    if not rows:
        return None
    return "\n\n".join(r["text"] for r in rows)


def corpus_stats(user_id: str) -> Dict[str, int]:
    docs_agg = (
        _documents_col()
        .where(filter=FieldFilter("user_id", "==", user_id))
        .where(filter=FieldFilter("status", "==", "ready"))
        .count()
        .get()
    )
    chunks_agg = (
        _chunks_col().where(filter=FieldFilter("user_id", "==", user_id)).count().get()
    )
    return {"documents": int(docs_agg[0][0].value), "chunks": int(chunks_agg[0][0].value)}
