"""Supabase Storage client for hosted multi-user DocBrain.

Used ONLY for file storage -- Firestore/Firebase Auth (see firebase_app.py,
db_cloud.py, auth.py) handle everything else. Both Firebase Storage (needs
the paid Blaze plan) and Cloudflare R2 (needs a card on file to activate,
even though usage stays free) require a payment method just to turn the
feature on; Supabase Storage's free tier needs no card at all, so this one
piece uses a separate free Supabase account.

Raw httpx calls to Supabase Storage's REST API -- no SDK, matching llm.py's
existing "raw HTTP, no provider SDKs" style. Always uses the service-role
key: this module is backend-only and never called from the frontend, so the
bucket can stay private with all access mediated by the backend's own auth
check.
"""
from __future__ import annotations

import os
from urllib.parse import quote

import httpx


class StorageError(Exception):
    pass


def _base_url() -> str:
    return os.environ["SUPABASE_URL"].rstrip("/") + "/storage/v1"


def _headers() -> dict:
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {"Authorization": f"Bearer {key}", "apikey": key}


def _bucket() -> str:
    return os.environ.get("STORAGE_BUCKET", "documents")


def _object_url(path: str) -> str:
    # Percent-encode each path segment (preserving the "/" separators between
    # {user_id}/{content_hash}{ext}) -- raw f-string concatenation was passing
    # path segments straight into the URL unencoded, which Supabase Storage's
    # router can reject as "Invalid path specified in request URL".
    encoded = "/".join(quote(part, safe="") for part in path.split("/"))
    return f"{_base_url()}/object/{quote(_bucket(), safe='')}/{encoded}"


def upload(path: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    resp = httpx.post(
        _object_url(path),
        headers={**_headers(), "Content-Type": content_type, "x-upsert": "true"},
        content=data,
        timeout=120,
    )
    if resp.status_code not in (200, 201):
        raise StorageError(f"Upload failed ({resp.status_code}): {resp.text[:300]}")


def download(path: str) -> bytes:
    resp = httpx.get(_object_url(path), headers=_headers(), timeout=120)
    if resp.status_code != 200:
        raise StorageError(f"Download failed ({resp.status_code}): {resp.text[:300]}")
    return resp.content


def remove(path: str) -> None:
    resp = httpx.request(
        "DELETE",
        f"{_base_url()}/object/{_bucket()}",
        headers=_headers(),
        json={"prefixes": [path]},
        timeout=60,
    )
    if resp.status_code not in (200, 204):
        raise StorageError(f"Delete failed ({resp.status_code}): {resp.text[:300]}")
