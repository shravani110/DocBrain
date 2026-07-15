"""Hosted-mode entry point: uvicorn serving app.api_cloud instead of app.api.
Also useful for local dev-testing hosted mode against a real Supabase
project before deploying -- set the required env vars and run this directly."""
from __future__ import annotations

import os

import uvicorn

from app.api_cloud import app


def main() -> None:
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))


if __name__ == "__main__":
    main()
