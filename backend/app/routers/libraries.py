"""Browse libraries, items, and item detail for a given server."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import db
from ..media.base import MediaError
from ..media.factory import client_for
from ..schemas import ItemDetail, NormalizedItem, NormalizedLibrary

router = APIRouter(prefix="/api/servers/{server_id}", tags=["libraries"])


def _client(server_id: int):
    server = db.get_server(server_id, include_token=True)
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")
    return client_for(server)


def _wrap(coro_exc: MediaError) -> HTTPException:
    return HTTPException(status_code=502, detail=str(coro_exc))


@router.get("/libraries", response_model=list[NormalizedLibrary])
async def get_libraries(server_id: int) -> list[NormalizedLibrary]:
    try:
        return await _client(server_id).get_libraries()
    except MediaError as exc:
        raise _wrap(exc)


@router.get("/libraries/{library_id}/items", response_model=list[NormalizedItem])
async def get_items(
    server_id: int, library_id: str, group_collections: bool = True
) -> list[NormalizedItem]:
    try:
        return await _client(server_id).get_items(library_id, group_collections=group_collections)
    except MediaError as exc:
        raise _wrap(exc)


@router.get("/items/{item_id}", response_model=ItemDetail)
async def get_item_detail(server_id: int, item_id: str) -> ItemDetail:
    try:
        return await _client(server_id).get_item_detail(item_id)
    except MediaError as exc:
        raise _wrap(exc)
