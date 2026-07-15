"""Folder watcher: native OS file events via watchdog, debounced.

Rapid event bursts for the same path (scanner apps write files in many small
appends) are coalesced with a per-path debounce timer; the ingest worker adds
a second size-stability check before reading.
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Dict, List

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .extract import SUPPORTED_EXTS
from .ingest import enqueue_file

DEBOUNCE_SECONDS = 2.0

_observer: Observer = None
_watched: List[str] = []
_lock = threading.Lock()


class _Handler(FileSystemEventHandler):
    def __init__(self) -> None:
        self._timers: Dict[str, threading.Timer] = {}
        self._tlock = threading.Lock()

    def _debounced_enqueue(self, path: str) -> None:
        if Path(path).suffix.lower() not in SUPPORTED_EXTS:
            return
        with self._tlock:
            timer = self._timers.pop(path, None)
            if timer:
                timer.cancel()
            t = threading.Timer(DEBOUNCE_SECONDS, self._fire, args=(path,))
            t.daemon = True
            self._timers[path] = t
            t.start()

    def _fire(self, path: str) -> None:
        with self._tlock:
            self._timers.pop(path, None)
        if Path(path).exists():
            enqueue_file(path)

    def on_created(self, event):
        if not event.is_directory:
            self._debounced_enqueue(event.src_path)

    def on_modified(self, event):
        if not event.is_directory:
            self._debounced_enqueue(event.src_path)

    def on_moved(self, event):
        if not event.is_directory:
            # Content hash means a pure rename is recognized and skipped
            # downstream; a genuinely new file gets processed.
            self._debounced_enqueue(event.dest_path)


def set_watched_folders(folders: List[str]) -> None:
    global _observer, _watched
    with _lock:
        if _observer is not None:
            _observer.stop()
            _observer = None
        valid = [f for f in folders if Path(f).is_dir()]
        _watched = valid
        if not valid:
            return
        _observer = Observer()
        handler = _Handler()
        for f in valid:
            _observer.schedule(handler, f, recursive=True)
        _observer.daemon = True
        _observer.start()


def watched_folders() -> List[str]:
    with _lock:
        return list(_watched)
