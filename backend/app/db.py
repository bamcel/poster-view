"""SQLite data layer.

A tiny hand-rolled layer over the stdlib ``sqlite3`` module keeps the
dependency surface minimal (important on very new Python versions) and the
schema is small enough that an ORM would be overkill. Secrets are stored
encrypted via :mod:`app.security`; callers always work with plaintext.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator, Optional

from .config import DB_PATH
from .security import decrypt, encrypt

SCHEMA = """
CREATE TABLE IF NOT EXISTS media_servers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    type        TEXT    NOT NULL CHECK (type IN ('plex', 'jellyfin', 'emby')),
    base_url    TEXT    NOT NULL,
    token_enc   TEXT    NOT NULL DEFAULT '',
    is_default  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key       TEXT PRIMARY KEY,
    value_enc TEXT NOT NULL DEFAULT ''
);

-- One row per successfully-applied image (any provider or manual upload) so
-- a bad pick can be reverted. The bytes themselves live on disk (see
-- app/history.py) since provider URLs can go stale or need auth we no
-- longer have handy; this table just indexes them.
CREATE TABLE IF NOT EXISTS apply_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id    INTEGER NOT NULL,
    item_id      TEXT    NOT NULL,
    item_title   TEXT    NOT NULL DEFAULT '',
    target       TEXT    NOT NULL,
    file_path    TEXT    NOT NULL,
    content_type TEXT    NOT NULL,
    provider     TEXT    NOT NULL DEFAULT '',
    applied_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_apply_history_item
    ON apply_history (server_id, item_id, target, applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_apply_history_recent
    ON apply_history (applied_at DESC);
"""

# Keys in the ``settings`` table whose values are encrypted at rest.
SECRET_SETTINGS = {"posterdb_password", "fanart_api_key", "tvdb_api_key", "tvdb_pin"}


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    """Yield a connection with row access by column name.

    A fresh connection per operation sidesteps cross-thread issues with the
    threadpool FastAPI uses for sync code, and SQLite handles this cheaply.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    """Additive schema changes for databases created before a column existed.

    CREATE TABLE IF NOT EXISTS in SCHEMA only creates a table the first time
    — an existing apply_history table from before item_title was added needs
    an explicit ALTER TABLE to pick it up.
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(apply_history)")}
    if "item_title" not in cols:
        conn.execute("ALTER TABLE apply_history ADD COLUMN item_title TEXT NOT NULL DEFAULT ''")


# ---------------------------------------------------------------------------
# Media servers
# ---------------------------------------------------------------------------

def _server_row_to_dict(row: sqlite3.Row, *, include_token: bool = False) -> dict[str, Any]:
    data = {
        "id": row["id"],
        "name": row["name"],
        "type": row["type"],
        "base_url": row["base_url"],
        "is_default": bool(row["is_default"]),
        "has_token": bool(row["token_enc"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if include_token:
        data["token"] = decrypt(row["token_enc"])
    return data


def list_servers() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM media_servers ORDER BY is_default DESC, name COLLATE NOCASE"
        ).fetchall()
    return [_server_row_to_dict(r) for r in rows]


def get_server(server_id: int, *, include_token: bool = False) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM media_servers WHERE id = ?", (server_id,)
        ).fetchone()
    return _server_row_to_dict(row, include_token=include_token) if row else None


def create_server(
    name: str, type_: str, base_url: str, token: str, is_default: bool
) -> dict[str, Any]:
    with get_conn() as conn:
        if is_default:
            conn.execute("UPDATE media_servers SET is_default = 0")
        cur = conn.execute(
            """INSERT INTO media_servers (name, type, base_url, token_enc, is_default)
               VALUES (?, ?, ?, ?, ?)""",
            (name, type_, base_url.rstrip("/"), encrypt(token), int(is_default)),
        )
        server_id = cur.lastrowid
        # Guarantee at least one default exists.
        if conn.execute("SELECT COUNT(*) FROM media_servers WHERE is_default = 1").fetchone()[0] == 0:
            conn.execute("UPDATE media_servers SET is_default = 1 WHERE id = ?", (server_id,))
    return get_server(server_id)  # type: ignore[return-value]


def update_server(
    server_id: int,
    *,
    name: Optional[str] = None,
    type_: Optional[str] = None,
    base_url: Optional[str] = None,
    token: Optional[str] = None,
    is_default: Optional[bool] = None,
) -> Optional[dict[str, Any]]:
    changes: dict[str, Any] = {}
    if name is not None:
        changes["name"] = name
    if type_ is not None:
        changes["type"] = type_
    if base_url is not None:
        changes["base_url"] = base_url.rstrip("/")
    if token:  # empty string means "leave the existing token unchanged"
        changes["token_enc"] = encrypt(token)
    if is_default is not None:
        changes["is_default"] = int(is_default)

    sets = [f"{col} = ?" for col in changes] + ["updated_at = datetime('now')"]
    with get_conn() as conn:
        if is_default:
            conn.execute("UPDATE media_servers SET is_default = 0")
        conn.execute(
            f"UPDATE media_servers SET {', '.join(sets)} WHERE id = ?",
            [*changes.values(), server_id],
        )
    return get_server(server_id)


def delete_server(server_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM media_servers WHERE id = ?", (server_id,))


# ---------------------------------------------------------------------------
# Settings (key/value, used for ThePosterDB credentials)
# ---------------------------------------------------------------------------

def get_setting(key: str) -> str:
    with get_conn() as conn:
        row = conn.execute("SELECT value_enc FROM settings WHERE key = ?", (key,)).fetchone()
    if not row:
        return ""
    raw = row["value_enc"]
    return decrypt(raw) if key in SECRET_SETTINGS else raw


def set_setting(key: str, value: str) -> None:
    stored = encrypt(value) if key in SECRET_SETTINGS else value
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO settings (key, value_enc) VALUES (?, ?)
               ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc""",
            (key, stored),
        )


# ---------------------------------------------------------------------------
# Apply history (revert-to-previous-image)
# ---------------------------------------------------------------------------

def insert_apply_history(
    server_id: int,
    item_id: str,
    target: str,
    file_path: str,
    content_type: str,
    provider: str,
    item_title: str = "",
) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO apply_history
               (server_id, item_id, item_title, target, file_path, content_type, provider)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (server_id, item_id, item_title, target, file_path, content_type, provider),
        )
        return cur.lastrowid  # type: ignore[return-value]


def list_apply_history(
    server_id: Optional[int] = None,
    item_id: Optional[str] = None,
    target: Optional[str] = None,
    limit: Optional[int] = None,
) -> list[dict[str, Any]]:
    """With ``item_id`` omitted, lists the most recent applies across
    ``server_id`` (or across every server, if that's omitted too) — the
    global history view."""
    query = "SELECT * FROM apply_history WHERE 1 = 1"
    params: list[Any] = []
    if server_id is not None:
        query += " AND server_id = ?"
        params.append(server_id)
    if item_id is not None:
        query += " AND item_id = ?"
        params.append(item_id)
    if target:
        query += " AND target = ?"
        params.append(target)
    query += " ORDER BY applied_at DESC, id DESC"
    if limit:
        query += " LIMIT ?"
        params.append(limit)
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]


def get_apply_history_entry(history_id: int) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM apply_history WHERE id = ?", (history_id,)).fetchone()
    return dict(row) if row else None


def prune_apply_history_global(keep: int) -> list[str]:
    """Delete all but the ``keep`` most recent rows across the whole table
    (not scoped to one item/target); returns the now-orphaned file paths so
    the caller can delete them from disk."""
    with get_conn() as conn:
        rows = conn.execute("SELECT id, file_path FROM apply_history ORDER BY applied_at DESC, id DESC").fetchall()
        stale = rows[keep:]
        for r in stale:
            conn.execute("DELETE FROM apply_history WHERE id = ?", (r["id"],))
    return [r["file_path"] for r in stale]


def purge_apply_history_older_than(days: int) -> list[str]:
    """Delete rows older than ``days`` days (``days <= 0`` deletes every
    row); returns the now-orphaned file paths."""
    with get_conn() as conn:
        if days > 0:
            rows = conn.execute(
                "SELECT id, file_path FROM apply_history WHERE applied_at < datetime('now', ?)",
                (f"-{days} days",),
            ).fetchall()
        else:
            rows = conn.execute("SELECT id, file_path FROM apply_history").fetchall()
        for r in rows:
            conn.execute("DELETE FROM apply_history WHERE id = ?", (r["id"],))
    return [r["file_path"] for r in rows]
