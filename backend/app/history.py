"""Apply history: keeps the most recent applied images so a bad pick can be
reverted without re-searching from scratch — and, via ``list_recent`` with
no ``item_id``, a global feed of everything applied across the server(s),
newest first.

Every successful apply — from any artwork provider or a manual upload —
records an entry here. The image bytes are saved to disk under
``DATA_DIR/history/`` rather than just remembering the source URL, since
provider URLs can go stale (ThePosterDB needs its authenticated session,
others may rate-limit, move, or require a Referer) — the bytes we already
downloaded to apply them are the one thing guaranteed to still be good.

Two independent, user-configurable caps keep this from growing forever: a
global row-count ceiling (``settings.history_max_entries``, always enforced
on insert — oldest rows + files pruned first once exceeded) and an optional
max age in days (``settings.history_purge_days``, 0 = disabled — only
entries *older than* this are ever touched, everything newer is left alone)
swept on every new apply.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Optional

from . import db
from .config import DATA_DIR

HISTORY_DIR = DATA_DIR / "history"
DEFAULT_MAX_ENTRIES = 50
MAX_ENTRIES_SETTING = "history_max_entries"
PURGE_DAYS_SETTING = "history_purge_days"

_EXT_BY_CONTENT_TYPE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/gif": ".gif",
}


def record(
    server_id: int,
    item_id: str,
    target: str,
    data: bytes,
    content_type: str,
    provider: str,
    item_title: str = "",
) -> None:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    ext = _EXT_BY_CONTENT_TYPE.get(content_type, ".img")
    path = HISTORY_DIR / f"{uuid.uuid4().hex}{ext}"
    path.write_bytes(data)
    db.insert_apply_history(server_id, item_id, target, str(path), content_type, provider, item_title)

    _delete_files(db.prune_apply_history_global(keep=get_max_entries()))

    days = get_purge_days()
    if days > 0:
        _delete_files(db.purge_apply_history_older_than(days))


def get_max_entries() -> int:
    raw = db.get_setting(MAX_ENTRIES_SETTING)
    return int(raw) if raw.isdigit() else DEFAULT_MAX_ENTRIES


def set_max_entries(count: int) -> None:
    db.set_setting(MAX_ENTRIES_SETTING, str(max(1, count)))


def get_purge_days() -> int:
    raw = db.get_setting(PURGE_DAYS_SETTING)
    return int(raw) if raw.isdigit() else 0


def set_purge_days(days: int) -> None:
    db.set_setting(PURGE_DAYS_SETTING, str(max(0, days)))


def enforce_max_entries() -> int:
    """Immediately prune to the current max_entries setting (rather than
    waiting for the next apply) — called right after the setting changes so
    lowering it takes effect right away. Returns how many were removed."""
    stale = db.prune_apply_history_global(keep=get_max_entries())
    _delete_files(stale)
    return len(stale)


def purge_now(days: Optional[int] = None) -> int:
    """Manual purge: uses ``days`` if given, else the saved setting (0/unset
    purges everything). Returns how many entries were removed."""
    effective = days if days is not None else get_purge_days()
    stale = db.purge_apply_history_older_than(effective)
    _delete_files(stale)
    return len(stale)


def _delete_files(paths: list[str]) -> None:
    for p in paths:
        Path(p).unlink(missing_ok=True)


def list_recent(
    server_id: Optional[int] = None,
    item_id: Optional[str] = None,
    target: Optional[str] = None,
    limit: Optional[int] = None,
) -> list[dict[str, Any]]:
    return db.list_apply_history(server_id, item_id, target, limit)


def get_entry(history_id: int) -> Optional[dict[str, Any]]:
    return db.get_apply_history_entry(history_id)


def read_image(entry: dict[str, Any]) -> tuple[bytes, str]:
    return Path(entry["file_path"]).read_bytes(), entry["content_type"]
