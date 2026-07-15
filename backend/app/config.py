"""App configuration and settings persistence.

Settings live in a JSON file under the per-user data directory. API keys are
NOT stored in this file -- they go to the OS keychain via `keyring`.
"""
from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional

APP_NAME = "LocalDocumentBrain"
KEYRING_SERVICE = "local-document-brain"


def data_dir() -> Path:
    """Per-user data directory following each platform's convention."""
    override = os.environ.get("DOCBRAIN_DATA_DIR")
    if override:
        d = Path(override)
    elif os.name == "nt":
        d = Path(os.environ.get("APPDATA", str(Path.home()))) / APP_NAME
    elif sys.platform == "darwin":
        d = Path.home() / "Library" / "Application Support" / APP_NAME
    else:  # Linux/BSD: honor XDG if set
        xdg = os.environ.get("XDG_DATA_HOME")
        d = (Path(xdg) if xdg else Path.home() / ".local" / "share") / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / "brain.db"


DEFAULT_SETTINGS: Dict[str, Any] = {
    # Watched folders (absolute paths).
    "watched_folders": [],
    # "local" (Ollama) | "anthropic" | "openai" | "none" (retrieval-only)
    "llm_provider": "none",
    "llm_model": "",            # empty -> provider default
    "ollama_url": "http://localhost:11434",
    "ollama_model": "qwen2.5:3b",
    # Cloud OCR fallback is OFF by default: nothing leaves the device.
    "cloud_ocr_enabled": False,
    "onboarded": False,
}

PROVIDER_DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-5",
    "openai": "gpt-4o",
    "gemini": "gemini-2.0-flash",
}

_lock = threading.Lock()


def _settings_path() -> Path:
    return data_dir() / "settings.json"


def load_settings() -> Dict[str, Any]:
    with _lock:
        merged = dict(DEFAULT_SETTINGS)
        p = _settings_path()
        if p.exists():
            try:
                merged.update(json.loads(p.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                pass
        return merged


def save_settings(updates: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        merged = dict(DEFAULT_SETTINGS)
        p = _settings_path()
        if p.exists():
            try:
                merged.update(json.loads(p.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError):
                pass
        for k, v in updates.items():
            if k in DEFAULT_SETTINGS:
                merged[k] = v
        p.write_text(json.dumps(merged, indent=2), encoding="utf-8")
        return merged


# --- API keys (OS keychain) -------------------------------------------------

def set_api_key(provider: str, key: Optional[str]) -> None:
    import keyring

    if key:
        keyring.set_password(KEYRING_SERVICE, f"{provider}-api-key", key)
    else:
        try:
            keyring.delete_password(KEYRING_SERVICE, f"{provider}-api-key")
        except keyring.errors.PasswordDeleteError:
            pass


def get_api_key(provider: str) -> Optional[str]:
    # Hosted/cloud deployments have no OS keychain -- a real env var takes
    # priority when present. No-op for existing local installs (never set).
    env_val = os.environ.get(f"{provider.upper()}_API_KEY")
    if env_val:
        return env_val

    import keyring

    try:
        return keyring.get_password(KEYRING_SERVICE, f"{provider}-api-key")
    except Exception:
        return None


def privacy_mode(settings: Optional[Dict[str, Any]] = None) -> str:
    """Human-readable mode string surfaced persistently in the UI."""
    s = settings or load_settings()
    provider = s.get("llm_provider", "none")
    if provider in ("none", "local"):
        return "Local only"
    if provider == "anthropic":
        return "Using Anthropic API"
    if provider == "openai":
        return "Using OpenAI API"
    return "Local only"
