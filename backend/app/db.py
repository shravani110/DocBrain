"""SQLite storage: documents, chunks, FTS5 keyword index, vector index.

Vector search uses the `sqlite-vec` extension when it loads; otherwise it
falls back to brute-force cosine similarity over numpy arrays, which is
perfectly adequate at this product's scale (hundreds to low thousands of
documents).
"""
from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .config import db_path

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_hash TEXT NOT NULL UNIQUE,
    doc_type TEXT NOT NULL DEFAULT 'other',
    doc_type_source TEXT NOT NULL DEFAULT 'auto',  -- auto | manual
    page_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',  -- queued|processing|ready|failed|removed
    status_detail TEXT NOT NULL DEFAULT '',
    used_ocr INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    page_number INTEGER NOT NULL,        -- 0-based
    bboxes TEXT NOT NULL DEFAULT '[]',   -- JSON [[page,x0,y0,x1,y1], ...]
    section_heading TEXT NOT NULL DEFAULT '',
    embedding BLOB,                      -- float32 little-endian
    embedding_dim INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text, content='chunks', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
"""


def get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(str(db_path()), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.executescript(SCHEMA)
        _try_load_sqlite_vec(conn)
        _local.conn = conn
    return conn


def _try_load_sqlite_vec(conn: sqlite3.Connection) -> None:
    _local.vec_available = False
    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0("
            "chunk_id INTEGER PRIMARY KEY, embedding float[384])"
        )
        _local.vec_available = True
    except Exception:
        pass  # brute-force numpy fallback in vector_search()


# --- documents ---------------------------------------------------------------


def upsert_document(path: str, filename: str, content_hash: str) -> Tuple[int, bool]:
    """Returns (document_id, is_new_content)."""
    conn = get_conn()
    row = conn.execute(
        "SELECT id, status FROM documents WHERE content_hash=?", (content_hash,)
    ).fetchone()
    if row:
        # 'removed' means the user deleted it from the library; a rescan of the
        # same content must not resurrect it.
        conn.execute(
            "UPDATE documents SET path=?, filename=? WHERE id=?",
            (path, filename, row["id"]),
        )
        conn.commit()
        return row["id"], False
    cur = conn.execute(
        "INSERT INTO documents (path, filename, content_hash) VALUES (?,?,?)",
        (path, filename, content_hash),
    )
    conn.commit()
    return cur.lastrowid, True


def set_document_status(doc_id: int, status: str, detail: str = "") -> None:
    conn = get_conn()
    if status == "ready":
        conn.execute(
            "UPDATE documents SET status=?, status_detail=?, processed_at=datetime('now') WHERE id=?",
            (status, detail, doc_id),
        )
    else:
        conn.execute(
            "UPDATE documents SET status=?, status_detail=? WHERE id=?",
            (status, detail, doc_id),
        )
    conn.commit()


def set_document_meta(doc_id: int, **fields: Any) -> None:
    allowed = {"doc_type", "doc_type_source", "page_count", "used_ocr"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return
    conn = get_conn()
    clause = ", ".join(f"{k}=?" for k in sets)
    conn.execute(f"UPDATE documents SET {clause} WHERE id=?", (*sets.values(), doc_id))
    conn.commit()


def get_document(doc_id: int) -> Optional[sqlite3.Row]:
    return get_conn().execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()


def list_documents() -> List[Dict[str, Any]]:
    rows = get_conn().execute(
        "SELECT id, path, filename, doc_type, doc_type_source, page_count, status, "
        "status_detail, used_ocr, added_at, processed_at FROM documents "
        "WHERE status != 'removed' ORDER BY added_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def mark_missing_documents(present_hashes: Sequence[str]) -> None:
    """Mark docs whose files vanished from all watched folders."""
    conn = get_conn()
    rows = conn.execute("SELECT id, content_hash FROM documents WHERE status='ready'").fetchall()
    present = set(present_hashes)
    for r in rows:
        if r["content_hash"] not in present:
            conn.execute("UPDATE documents SET status='removed' WHERE id=?", (r["id"],))
    conn.commit()


def delete_chunks_for_document(doc_id: int) -> None:
    conn = get_conn()
    if getattr(_local, "vec_available", False):
        conn.execute(
            "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id=?)",
            (doc_id,),
        )
    conn.execute("DELETE FROM chunks WHERE document_id=?", (doc_id,))
    conn.commit()


# --- chunks ------------------------------------------------------------------


def insert_chunks(doc_id: int, chunks: List[Dict[str, Any]], embeddings: Optional[np.ndarray]) -> None:
    conn = get_conn()
    for i, ch in enumerate(chunks):
        emb_blob, dim = None, 0
        if embeddings is not None:
            vec = np.asarray(embeddings[i], dtype=np.float32)
            emb_blob, dim = vec.tobytes(), int(vec.shape[0])
        cur = conn.execute(
            "INSERT INTO chunks (document_id, chunk_index, text, page_number, bboxes, "
            "section_heading, embedding, embedding_dim) VALUES (?,?,?,?,?,?,?,?)",
            (
                doc_id, i, ch["text"], ch["page_number"],
                json.dumps(ch.get("bboxes", [])), ch.get("section_heading", ""),
                emb_blob, dim,
            ),
        )
        if emb_blob is not None and getattr(_local, "vec_available", False) and dim == 384:
            try:
                conn.execute(
                    "INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?,?)",
                    (cur.lastrowid, emb_blob),
                )
            except sqlite3.Error:
                pass
    conn.commit()


def get_chunk(chunk_id: int) -> Optional[Dict[str, Any]]:
    row = get_conn().execute(
        "SELECT c.*, d.filename, d.path, d.doc_type FROM chunks c "
        "JOIN documents d ON d.id=c.document_id WHERE c.id=?",
        (chunk_id,),
    ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["bboxes"] = json.loads(d["bboxes"])
    d.pop("embedding", None)
    return d


# --- search ------------------------------------------------------------------


def keyword_search(query: str, limit: int = 20, doc_types: Optional[List[str]] = None) -> List[Tuple[int, float]]:
    """BM25 via FTS5. Returns [(chunk_id, score)] with higher = better."""
    conn = get_conn()
    # FTS5 query syntax chokes on punctuation; quote each term.
    terms = [t.replace('"', "") for t in query.split() if t.strip('"\'.,?!()[]{}:;')]
    if not terms:
        return []
    match = " OR ".join(f'"{t}"' for t in terms)
    sql = (
        "SELECT c.id, bm25(chunks_fts) AS score FROM chunks_fts "
        "JOIN chunks c ON c.id = chunks_fts.rowid "
        "JOIN documents d ON d.id = c.document_id AND d.status='ready' "
        "WHERE chunks_fts MATCH ? "
    )
    params: List[Any] = [match]
    if doc_types:
        sql += f"AND d.doc_type IN ({','.join('?' * len(doc_types))}) "
        params.extend(doc_types)
    sql += "ORDER BY score LIMIT ?"
    params.append(limit)
    try:
        rows = conn.execute(sql, params).fetchall()
    except sqlite3.OperationalError:
        return []
    # bm25() returns lower-is-better; negate so higher = better.
    return [(r["id"], -r["score"]) for r in rows]


def vector_search(query_vec: np.ndarray, limit: int = 20, doc_types: Optional[List[str]] = None) -> List[Tuple[int, float]]:
    """Cosine similarity. Returns [(chunk_id, score)] with higher = better."""
    conn = get_conn()
    q = np.asarray(query_vec, dtype=np.float32)
    qn = q / (np.linalg.norm(q) + 1e-9)

    sql = (
        "SELECT c.id, c.embedding, c.embedding_dim FROM chunks c "
        "JOIN documents d ON d.id=c.document_id AND d.status='ready' "
        "WHERE c.embedding IS NOT NULL"
    )
    params: List[Any] = []
    if doc_types:
        sql += f" AND d.doc_type IN ({','.join('?' * len(doc_types))})"
        params.extend(doc_types)
    rows = conn.execute(sql, params).fetchall()
    if not rows:
        return []
    ids, mats = [], []
    for r in rows:
        if r["embedding_dim"] != q.shape[0]:
            continue
        ids.append(r["id"])
        mats.append(np.frombuffer(r["embedding"], dtype=np.float32))
    if not ids:
        return []
    mat = np.vstack(mats)
    mat = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
    sims = mat @ qn
    order = np.argsort(-sims)[:limit]
    return [(ids[i], float(sims[i])) for i in order]


def get_document_text(doc_id: int, page: int) -> Optional[str]:
    rows = get_conn().execute(
        "SELECT text FROM chunks WHERE document_id=? AND page_number=? ORDER BY chunk_index",
        (doc_id, page),
    ).fetchall()
    if not rows:
        return None
    return "\n\n".join(r["text"] for r in rows)


def corpus_stats() -> Dict[str, int]:
    conn = get_conn()
    docs = conn.execute("SELECT COUNT(*) FROM documents WHERE status='ready'").fetchone()[0]
    chunks = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    return {"documents": docs, "chunks": chunks}
