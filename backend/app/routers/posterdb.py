"""ThePosterDB credentials, search/scrape, and the apply-to-server action."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response

from .. import db, history
from ..artwork.base import ArtworkError, download_public_image
from ..media.base import MediaError
from ..media.factory import client_for
from ..posterdb import posterdb
from ..posterdb.client import PosterDBError
from ..schemas import (
    ApplyRequest,
    ApplyResult,
    PosterDBCredentials,
    PosterDBStatus,
    PosterSearchResults,
    PosterSet,
    VerifyTitlesRequest,
)

router = APIRouter(prefix="/api/posterdb", tags=["posterdb"])


@router.get("/status", response_model=PosterDBStatus)
async def status() -> PosterDBStatus:
    return PosterDBStatus(**await posterdb.status())


@router.put("/credentials", response_model=PosterDBStatus)
async def set_credentials(creds: PosterDBCredentials) -> PosterDBStatus:
    db.set_setting("posterdb_email", creds.email.strip())
    # Empty password = keep the stored one (so the UI can omit it on edits).
    if creds.password:
        db.set_setting("posterdb_password", creds.password)
    posterdb.reset()  # force re-auth with the new credentials on next use
    return PosterDBStatus(**await posterdb.status())


@router.post("/login", response_model=PosterDBStatus)
async def test_login() -> PosterDBStatus:
    posterdb.reset()
    try:
        await posterdb.login()
        message = "Logged in to ThePosterDB."
    except PosterDBError as exc:
        return PosterDBStatus(**{**await posterdb.status(), "message": str(exc)})
    return PosterDBStatus(**{**await posterdb.status(), "message": message})


@router.get("/search", response_model=PosterSearchResults)
async def search(term: str = Query(..., min_length=1)) -> PosterSearchResults:
    try:
        return await posterdb.search(term)
    except PosterDBError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/set", response_model=PosterSet)
async def get_set(url: str = Query(..., description="set/poster URL or numeric id")) -> PosterSet:
    try:
        return await posterdb.get_set(url)
    except PosterDBError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/verify", response_model=dict[str, int])
async def verify_titles(req: VerifyTitlesRequest) -> dict[str, int]:
    """Return poster counts per title media-id (so the UI can hide empty ones)."""
    try:
        return await posterdb.verify_titles(req.ids)
    except PosterDBError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/image")
async def poster_image(url: str = Query(..., description="ThePosterDB image URL")) -> Response:
    """Proxy a ThePosterDB thumbnail using the authenticated session.

    TPDb's image CDN rejects cross-origin requests that lack a session, so the
    browser can't load thumbnails directly — we fetch (and cache) them here.
    """
    try:
        data, content_type = await posterdb.fetch_thumb(url)
    except PosterDBError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(content=data, media_type=content_type, headers={"Cache-Control": "public, max-age=86400"})


@router.post("/apply", response_model=ApplyResult)
async def apply(req: ApplyRequest) -> ApplyResult:
    server = db.get_server(req.server_id, include_token=True)
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")

    # ThePosterDB assets need the authenticated session; other providers
    # (Fanart/TVDB/AniList) serve public image URLs.
    try:
        if req.provider == "posterdb":
            data, content_type = await posterdb.download(req.download_url)
        else:
            data, content_type = await download_public_image(req.download_url)
    except (PosterDBError, ArtworkError) as exc:
        return ApplyResult(ok=False, message=f"Download failed: {exc}")

    try:
        await client_for(server).set_image(req.item_id, req.target, data, content_type)
    except MediaError as exc:
        return ApplyResult(ok=False, message=f"Upload failed: {exc}")

    history.record(req.server_id, req.item_id, req.target, data, content_type, req.provider, req.item_title)
    return ApplyResult(ok=True, message=f"Updated {req.target} successfully.")
