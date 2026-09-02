"""Application configuration and filesystem paths.

All persistent state (the SQLite database and the encryption key) lives in a
single data directory so the app is trivial to back up or relocate. The
directory can be overridden with the ``POSTERVIEW_DATA_DIR`` environment variable,
which is handy when running under Docker.
"""

from __future__ import annotations

import os
from pathlib import Path

# Repository layout: <repo>/backend/app/config.py -> backend/ is parents[1]
BACKEND_DIR = Path(__file__).resolve().parents[1]

DATA_DIR = Path(os.environ.get("POSTERVIEW_DATA_DIR", BACKEND_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "posterview.db"
SECRET_KEY_PATH = DATA_DIR / "secret.key"

# Where the built frontend is expected (frontend/dist). Served as static files
# in production; in development the Vite dev server proxies /api to us instead.
FRONTEND_DIST = BACKEND_DIR.parent / "frontend" / "dist"

# Network timeout (seconds) for outbound requests to media servers / ThePosterDB.
HTTP_TIMEOUT = float(os.environ.get("POSTERVIEW_HTTP_TIMEOUT", "30"))

# ThePosterDB base URL (overridable only for testing).
POSTERDB_BASE_URL = os.environ.get("POSTERVIEW_POSTERDB_URL", "https://theposterdb.com").rstrip("/")

# A realistic User-Agent avoids being blocked by ThePosterDB's edge.
USER_AGENT = os.environ.get(
    "POSTERVIEW_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
)
