"""Artwork provider endpoints: provider list, API-key settings, and lookup."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, Response, UploadFile

from .. import db, history
from ..artwork import get_provider, provider_infos
from ..artwork.base import ArtworkError
from ..artwork.tvdb import remote_id
from ..media.base import MediaError
from ..media.factory import client_for
from ..schemas import (
    ApplyResult,
    ArtworkProviderInfo,
    ArtworkResults,
    ArtworkSearchResult,
    ArtworkSearchResults,
    ArtworkSettings,
    ArtworkSettingsUpdate,
    ImageTarget,
)

router = APIRouter(prefix="/api/artwork", tags=["artwork"])


@router.get("/providers", response_model=list[ArtworkProviderInfo])
def list_providers() -> list[ArtworkProviderInfo]:
    return provider_infos()


@router.get("/settings", response_model=ArtworkSettings)
def get_settings() -> ArtworkSettings:
    return ArtworkSettings(
        fanart_configured=bool(db.get_setting("fanart_api_key")),
        tvdb_configured=bool(db.get_setting("tvdb_api_key")),
    )


@router.put("/settings", response_model=ArtworkSettings)
def update_settings(payload: ArtworkSettingsUpdate) -> ArtworkSettings:
    # Empty/None means "leave unchanged" (so the UI can omit them on edits).
    if payload.fanart_api_key:
        db.set_setting("fanart_api_key", payload.fanart_api_key.strip())
    if payload.tvdb_api_key:
        db.set_setting("tvdb_api_key", payload.tvdb_api_key.strip())
    if payload.tvdb_pin is not None:
        db.set_setting("tvdb_pin", payload.tvdb_pin.strip())
    return get_settings()


@router.get("", response_model=ArtworkResults)
async def get_artwork(
    provider: str = Query(...),
    server_id: int = Query(...),
    item_id: str = Query(...),
    id_override: Optional[str] = Query(
        None, description="Manually entered id (or, for AniList, a search term) overriding auto-detection"
    ),
) -> ArtworkResults:
    prov = get_provider(provider)
    if prov is None:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider}")

    server = db.get_server(server_id, include_token=True)
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")

    try:
        item = await client_for(server).get_item_detail(item_id)
    except MediaError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    try:
        items = await prov.fetch(item, id_override=id_override)
    except ArtworkError as exc:
        # A friendly message (e.g. missing id / key) rather than a hard error.
        return ArtworkResults(provider=provider, item_title=item.title, items=[], message=str(exc))
    return ArtworkResults(provider=provider, item_title=item.title, items=items)


@router.get("/search", response_model=ArtworkSearchResults)
async def search_artwork(
    provider: str = Query(...),
    server_id: int = Query(...),
    item_id: str = Query(...),
    query: str = Query(..., min_length=1),
) -> ArtworkSearchResults:
    """Title search for providers whose id box has no match — currently
    Fanart.tv, TheTVDB, and MediUX, all backed by TheTVDB's own /search
    endpoint (none of the three has a title-search API of its own: Fanart
    has none at all, and MediUX's is invite-only beta; see remote_id() in
    tvdb.py for how a movie candidate's TMDB/IMDb id, which Fanart and
    MediUX need instead of a TVDB one, is derived from it).
    """
    if provider not in ("tvdb", "fanart", "mediux"):
        raise HTTPException(status_code=400, detail=f"Title search isn't available for {provider}.")

    server = db.get_server(server_id, include_token=True)
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")
    try:
        item = await client_for(server).get_item_detail(item_id)
    except MediaError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    tvdb = get_provider("tvdb")
    if tvdb is None:
        raise HTTPException(status_code=500, detail="TheTVDB provider unavailable")
    kind = "movie" if item.type == "movie" else "series"

    try:
        raw = await tvdb.search(query, kind)
    except ArtworkError as exc:
        return ArtworkSearchResults(provider=provider, results=[], message=str(exc))

    results: list[ArtworkSearchResult] = []
    for c in raw:
        if provider == "tvdb":
            cid = c.get("tvdb_id")
        elif provider == "mediux":
            # MediUX addresses movies and shows alike by TMDB id — no IMDb fallback.
            cid = remote_id(c, "TheMovieDB.com")
        else:  # fanart: shows want a TVDB id, movies want TMDB (or IMDb)
            cid = c.get("tvdb_id") if kind == "series" else (remote_id(c, "TheMovieDB.com") or remote_id(c, "IMDB"))
        if not cid:
            continue
        results.append(
            ArtworkSearchResult(
                id=str(cid),
                name=c.get("name") or c.get("extended_title") or query,
                year=c.get("year"),
                thumb_url=c.get("image_url"),
            )
        )
    return ArtworkSearchResults(provider=provider, results=results)


@router.get("/mediux/image")
async def mediux_image(url: str = Query(..., description="MediUX image-proxy URL")) -> Response:
    """Proxy a MediUX thumbnail — its own Next.js image proxy 403s without a
    same-origin Referer, so the browser can't load thumbnails directly."""
    prov = get_provider("mediux")
    if prov is None:
        raise HTTPException(status_code=404, detail="MediUX provider not available")
    try:
        data, content_type = await prov.fetch_thumb(url)  # type: ignore[attr-defined]
    except ArtworkError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(content=data, media_type=content_type, headers={"Cache-Control": "public, max-age=86400"})


@router.post("/upload", response_model=ApplyResult)
async def upload_image(
    server_id: int = Form(...),
    item_id: str = Form(..., description="show/movie id, or a season id"),
    target: ImageTarget = Form("poster"),
    item_title: str = Form(""),
    file: UploadFile = File(...),
) -> ApplyResult:
    """Apply a user-supplied image file as an item's poster/background.

    ``item_id`` may be a season's id (with target=poster) to set season artwork.
    """
    server = db.get_server(server_id, include_token=True)
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    content_type = file.content_type or "image/jpeg"
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="That file isn't an image.")

    try:
        await client_for(server).set_image(item_id, target, data, content_type)
    except MediaError as exc:
        return ApplyResult(ok=False, message=f"Upload failed: {exc}")

    history.record(server_id, item_id, target, data, content_type, "manual", item_title)
    return ApplyResult(ok=True, message="Applied your image successfully.")
