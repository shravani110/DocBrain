"""Hybrid retrieval for hosted multi-user DocBrain -- mirrors retrieval.py's
vector+BM25 fusion and re-ranking exactly, but threads user_id through to
db_cloud instead of the local single-user db module. embeddings.py and
classify.py are reused completely unchanged (stateless, no DB access).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import db_cloud, embeddings
from .classify import infer_query_doc_types
from .retrieval import _rrf, _tokenize  # reuse the fusion + tokenizer helpers as-is

CANDIDATES = 20
FINAL_K = 6


def filename_hints(query: str, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Same logic as retrieval.py::filename_hints -- documents is already
    user-scoped by the caller (db_cloud.list_documents(user_id))."""
    qtoks = _tokenize(query)
    if not qtoks:
        return []
    hints = []
    for d in documents:
        if d.get("status") != "failed":
            continue
        base = d["filename"].rsplit(".", 1)[0]
        if _tokenize(base) & qtoks:
            hints.append({
                "document_id": d["id"],
                "filename": d["filename"],
                "reason": d.get("status_detail") or "No readable text was found in this file.",
            })
    return hints[:5]


def retrieve(user_id: str, query: str, doc_types: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """Returns the top chunks (dicts with text + metadata + retrieval info),
    scoped to this user's documents only."""
    if doc_types is None:
        doc_types = infer_query_doc_types(query)
    filters = doc_types or None

    qvec = embeddings.embed_query(query)
    vec_hits = db_cloud.vector_search(user_id, qvec, limit=CANDIDATES, doc_types=filters)
    kw_hits = db_cloud.keyword_search(user_id, query, limit=CANDIDATES, doc_types=filters)

    if filters and not vec_hits and not kw_hits:
        vec_hits = db_cloud.vector_search(user_id, qvec, limit=CANDIDATES)
        kw_hits = db_cloud.keyword_search(user_id, query, limit=CANDIDATES)

    fused = _rrf(vec_hits, kw_hits)[:CANDIDATES]
    if not fused:
        return []

    chunk_map = {}
    for cid, _ in fused:
        ch = db_cloud.get_chunk(user_id, cid)
        if ch:
            chunk_map[cid] = ch

    candidates = [(cid, chunk_map[cid]["text"]) for cid, _ in fused if cid in chunk_map]
    reranked = embeddings.rerank(query, candidates, top_k=FINAL_K)
    if reranked is None:
        final = [(cid, score) for cid, score in fused if cid in chunk_map][:FINAL_K]
    else:
        final = reranked

    results = []
    for cid, score in final:
        ch = chunk_map[cid]
        ch["retrieval_score"] = score
        results.append(ch)
    return results
