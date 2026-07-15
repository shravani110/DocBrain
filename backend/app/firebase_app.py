"""Shared Firebase Admin SDK bootstrap for hosted multi-user DocBrain.

Single firebase_admin App instance shared by auth.py and db_cloud.py
(Firestore + Auth only -- file storage uses Cloudflare R2 via storage.py
instead of Firebase Storage, which requires the paid Blaze plan).
firebase_admin.initialize_app() raises ValueError if called more than once
per process.
"""
from __future__ import annotations

import json
import os

import firebase_admin
from firebase_admin import credentials, firestore

_app = None


def get_app():
    global _app
    if _app is None:
        cred = credentials.Certificate(json.loads(os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"]))
        _app = firebase_admin.initialize_app(cred)
    return _app


def get_firestore_client():
    get_app()
    return firestore.client()
