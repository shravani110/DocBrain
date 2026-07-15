"""Hybrid retrieval: vector similarity + BM25 keyword search, fused with
reciprocal rank fusion, then cross-encoder re-ranking of the top ~20 down to
the top 6 sent to the LLM.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from . import db, embeddings
from .classify import infer_query_doc_types

CANDIDATES = 20
FINAL_K = 6
RRF_K = 60

# Generic words in a question ("show me the X image") that say nothing about
# which file the user means -- excluded so filename matching keys on the
# actual identifying term ("neptune").
_FILE_HINT_STOPWORDS = {
    "the", "and", "for", "with", "from", "this", "that", "what", "show",
    "find", "open", "image", "picture", "photo", "file", "document", "about",
    "your", "you", "please",
}


def _tokenize(text: str) -> set:
    return {
        t for t in re.findall(r"[a-z0-9]+", text.lower())
        if len(t) >= 3 and t not in _FILE_HINT_STOPWORDS
    }


def filename_hints(query: str, documents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Files with no searchable text (e.g. a photo OCR couldn't read) whose
    filename matches the query. These can't be grounded in retrieved content,
    so they're surfaced separately instead of silently missing -- or worse,
    the answer being drawn from an unrelated document that happens to share
    a word with the filename."""
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


def retrieve(query: str, doc_types: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """Returns the top chunks (dicts with text + metadata + retrieval info)."""
    if doc_types is None:
        doc_types = infer_query_doc_types(query)
    filters = doc_types or None

    qvec = embeddings.embed_query(query)
    vec_hits = db.vector_search(qvec, limit=CANDIDATES, doc_types=filters)
    kw_hits = db.keyword_search(query, limit=CANDIDATES, doc_types=filters)

    # If a type filter produced nothing, retry unfiltered rather than
    # answering "not found" because classification guessed wrong.
    if filters and not vec_hits and not kw_hits:
        vec_hits = db.vector_search(qvec, limit=CANDIDATES)
        kw_hits = db.keyword_search(query, limit=CANDIDATES)
        doc_types = []

    fused = _rrf(vec_hits, kw_hits)[:CANDIDATES]
    if not fused:
        return []

    chunk_map = {}
    for cid, _ in fused:
        ch = db.get_chunk(cid)
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


def _rrf(*rankings: List) -> List:
    scores: Dict[int, float] = {}
    for ranking in rankings:
        for rank, (cid, _) in enumerate(ranking):
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank + 1)
    return sorted(scores.items(), key=lambda x: -x[1])
