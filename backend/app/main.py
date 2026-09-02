"""PosterView FastAPI application entry point.

In production the built frontend (``frontend/dist``) is served as static files
from the same origin as the API, so no CORS is needed. In development the Vite
dev server runs separately and proxies ``/api`` here; the CORS rule below allows
that localhost origin.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, db
from .config import FRONTEND_DIST
from .posterdb import posterdb
from .routers import artwork, history, libraries, posterdb as posterdb_router, servers


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield
    await posterdb.close()


app = FastAPI(title="PosterView", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(servers.router)
app.include_router(libraries.router)
app.include_router(posterdb_router.router)
app.include_router(artwork.router)
app.include_router(history.router)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": __version__}


# ---------------------------------------------------------------------------
# Serve the built SPA (production only). Registered last so /api/* and the
# auto-generated /docs routes take precedence over the catch-all.
# ---------------------------------------------------------------------------
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str) -> FileResponse:
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
