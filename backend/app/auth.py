"""Firebase ID token verification for hosted multi-user DocBrain.

Every hosted-mode route depends on get_current_user(), which is the sole
per-user isolation boundary between requests -- db_cloud.py trusts the
user_id this returns completely, so a bug here is a cross-user data leak.
"""
from __future__ import annotations

from fastapi import HTTPException, Request
from firebase_admin import auth as firebase_auth

from .firebase_app import get_app


class AuthError(HTTPException):
    def __init__(self, detail: str = "Not authenticated"):
        super().__init__(status_code=401, detail=detail)


def get_current_user(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        token = header[len("Bearer "):].strip()
    else:
        # <img src="..."> can't send custom headers -- the page-image endpoint
        # is loaded that way, so it needs a query-param fallback. The header
        # is used everywhere else and always takes priority when present.
        token = request.query_params.get("token", "")
    if not token:
        raise AuthError("Missing bearer token")

    get_app()
    try:
        # Local signature verification against Google's cached public certs --
        # no per-request network round-trip once certs are cached. Not passing
        # check_revoked=True, which would add one.
        payload = firebase_auth.verify_id_token(token)
    except Exception as e:
        raise AuthError(f"Invalid token: {type(e).__name__}")

    user_id = payload.get("uid")
    if not user_id:
        raise AuthError("Token missing uid claim")
    return user_id
