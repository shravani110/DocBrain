"""Local embeddings and re-ranking.

Primary: fastembed (ONNX, CPU-friendly, no torch) with BAAI/bge-small-en-v1.5
(384-dim). Optional cross-encoder re-ranking via fastembed's TextCrossEncoder.

Fallback: a deterministic hashed bag-of-words embedder so the app still
functions (degraded, keyword-search-dominant) when model downloads are
unavailable. The active backend is reported in /api/status so the UI never
pretends degraded search is full quality.
"""
from __future__ import annotations

import hashlib
import math
import re
import threading
from typing import List, Optional, Sequence, Tuple

import numpy as np

EMBED_DIM = 384
_lock = threading.Lock()
_embedder = None
_embedder_kind = None  # "fastembed" | "hash"
_reranker = None
_reranker_failed = False


def _init_embedder() -> None:
    global _embedder, _embedder_kind
    if _embedder_kind is not None:
        return
    with _lock:
        if _embedder_kind is not None:
            return
        try:
            from fastembed import TextEmbedding

            _embedder = TextEmbedding(model_name="BAAI/bge-small-en-v1.5")
            _embedder_kind = "fastembed"
        except Exception:
            _embedder = None
            _embedder_kind = "hash"


def backend_name() -> str:
    # Deliberately does NOT trigger initialization: the first model load can
    # download weights, and this is called from the status-poll endpoint.
    if _embedder_kind is None:
        return "not loaded yet (loads on first index/search)"
    return "bge-small-en-v1.5 (fastembed)" if _embedder_kind == "fastembed" else "hashed-bow fallback"


def embed_texts(texts: Sequence[str]) -> np.ndarray:
    _init_embedder()
    if _embedder_kind == "fastembed":
        vecs = list(_embedder.embed(list(texts), batch_size=16))
        return np.asarray(vecs, dtype=np.float32)
    return np.vstack([_hash_embed(t) for t in texts])


def embed_query(text: str) -> np.ndarray:
    # bge models expect a retrieval instruction prefix on queries.
    _init_embedder()
    if _embedder_kind == "fastembed":
        prefixed = "Represent this sentence for searching relevant passages: " + text
        return np.asarray(next(iter(_embedder.embed([prefixed]))), dtype=np.float32)
    return _hash_embed(text)


_token_re = re.compile(r"[a-z0-9]+")


def _hash_embed(text: str) -> np.ndarray:
    vec = np.zeros(EMBED_DIM, dtype=np.float32)
    tokens = _token_re.findall(text.lower())
    for tok in tokens:
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        idx = h % EMBED_DIM
        sign = 1.0 if (h >> 20) % 2 == 0 else -1.0
        vec[idx] += sign
    n = np.linalg.norm(vec)
    return vec / n if n > 0 else vec


# --- re-ranking ---------------------------------------------------------------


def _init_reranker():
    global _reranker, _reranker_failed
    if _reranker is not None or _reranker_failed:
        return _reranker
    with _lock:
        if _reranker is not None or _reranker_failed:
            return _reranker
        try:
            from fastembed.rerank.cross_encoder import TextCrossEncoder

            _reranker = TextCrossEncoder(model_name="Xenova/ms-marco-MiniLM-L-6-v2")
        except Exception:
            _reranker_failed = True
    return _reranker


def rerank(query: str, candidates: List[Tuple[int, str]], top_k: int) -> Optional[List[Tuple[int, float]]]:
    """candidates: [(chunk_id, text)]. Returns [(chunk_id, score)] descending,
    or None if no cross-encoder is available (caller keeps fusion order)."""
    rr = _init_reranker()
    if rr is None:
        return None
    try:
        scores = list(rr.rerank(query, [t for _, t in candidates]))
        ranked = sorted(zip((cid for cid, _ in candidates), scores), key=lambda x: -x[1])
        return [(cid, float(s)) for cid, s in ranked[:top_k]]
    except Exception:
        return None
