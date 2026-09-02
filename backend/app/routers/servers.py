"""Media-server CRUD, connection testing, and the image proxy."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response

from .. import db
from ..media.base import MediaError
from ..media.factory import client_for
from ..schemas import ConnectionTest, ServerCreate, ServerOut, ServerUpdate

router = APIRouter(prefix="/api/servers", tags=["servers"])


def _require_server(server_id: int, *, include_token: bool = False) -> dict:
    server = db.get_server(server_id, include_token=include_token)
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


@router.get("", response_model=list[ServerOut])
def list_servers() -> list[dict]:
    return db.list_servers()


@router.post("", response_model=ServerOut, status_code=201)
def create_server(payload: ServerCreate) -> dict:
    return db.create_server(
        payload.name, payload.type, payload.base_url, payload.token, payload.is_default
    )


@router.get("/{server_id}", response_model=ServerOut)
def get_server(server_id: int) -> dict:
    return _require_server(server_id)


@router.patch("/{server_id}", response_model=ServerOut)
def update_server(server_id: int, payload: ServerUpdate) -> dict:
    _require_server(server_id)
    updated = db.update_server(
        server_id,
        name=payload.name,
        type_=payload.type,
        base_url=payload.base_url,
        token=payload.token,
        is_default=payload.is_default,
    )
    return updated  # type: ignore[return-value]


@router.delete("/{server_id}", status_code=204)
def delete_server(server_id: int) -> Response:
    _require_server(server_id)
    db.delete_server(server_id)
    return Response(status_code=204)


@router.post("/test", response_model=ConnectionTest)
async def test_adhoc(payload: ServerCreate) -> ConnectionTest:
    """Test arbitrary credentials before saving them."""
    client = client_for(
        {"type": payload.type, "base_url": payload.base_url, "token": payload.token}
    )
    return await _run_test(client)


@router.post("/{server_id}/test", response_model=ConnectionTest)
async def test_saved(server_id: int) -> ConnectionTest:
    server = _require_server(server_id, include_token=True)
    return await _run_test(client_for(server))


async def _run_test(client) -> ConnectionTest:
    try:
        name, version = await client.test_connection()
        return ConnectionTest(ok=True, message="Connected successfully.", server_name=name, version=version)
    except MediaError as exc:
        return ConnectionTest(ok=False, message=str(exc))
    except Exception as exc:  # noqa: BLE001 - surface anything else as a clean failure
        return ConnectionTest(ok=False, message=f"Unexpected error: {exc}")


@router.get("/{server_id}/image")
async def proxy_image(server_id: int, ref: str = Query(..., description="opaque image ref")) -> Response:
    """Stream an item's image from the origin server, injecting auth server-side.

    Keeps origin tokens out of the browser and avoids CORS entirely.
    """
    server = _require_server(server_id, include_token=True)
    client = client_for(server)
    try:
        data, content_type = await client.fetch_image(ref)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Image fetch failed: {exc}") from exc
    return Response(
        content=data,
        media_type=content_type,
        headers={"Cache-Control": "public, max-age=3600"},
    )
