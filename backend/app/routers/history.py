"""Apply history: list, view, and revert previously-applied images."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Response

from .. import db, history
from ..media.base import MediaError
from ..media.factory import client_for
from ..schemas import ApplyHistoryEntry, ApplyResult, HistoryPurgeResult, HistorySettings

router = APIRouter(prefix="/api/history", tags=["history"])


@router.get("/settings", response_model=HistorySettings)
async def get_settings() -> HistorySettings:
    return HistorySettings(purge_days=history.get_purge_days(), max_entries=history.get_max_entries())


@router.put("/settings", response_model=HistorySettings)
async def update_settings(payload: HistorySettings) -> HistorySettings:
    history.set_purge_days(payload.purge_days)
    history.set_max_entries(payload.max_entries)
    history.enforce_max_entries()  # apply a lowered cap immediately, not on the next apply
    return HistorySettings(purge_days=history.get_purge_days(), max_entries=history.get_max_entries())


@router.post("/purge", response_model=HistoryPurgeResult)
async def purge(days: Optional[int] = Query(None, description="Omit to use the saved setting")) -> HistoryPurgeResult:
    return HistoryPurgeResult(purged=history.purge_now(days))


@router.get("", response_model=list[ApplyHistoryEntry])
async def list_history(
    server_id: Optional[int] = Query(None),
    item_id: Optional[str] = Query(None),
    target: Optional[str] = Query(None),
    limit: Optional[int] = Query(None, description="Caps results; only meaningful without item_id"),
) -> list[ApplyHistoryEntry]:
    """With ``item_id`` omitted this is the global history feed — every
    apply across ``server_id`` (or every server, if that's omitted too),
    newest first."""
    rows = history.list_recent(server_id, item_id, target, limit)
    server_names = {s["id"]: s["name"] for s in db.list_servers()}
    return [
        ApplyHistoryEntry(
            id=r["id"],
            server_id=r["server_id"],
            server_name=server_names.get(r["server_id"], ""),
            item_id=r["item_id"],
            item_title=r["item_title"],
            target=r["target"],
            provider=r["provider"],
            applied_at=r["applied_at"],
            thumb_url=f"/api/history/{r['id']}/image",
        )
        for r in rows
    ]


@router.get("/{history_id}/image")
async def history_image(history_id: int) -> Response:
    entry = history.get_entry(history_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="History entry not found")
    data, content_type = history.read_image(entry)
    return Response(content=data, media_type=content_type, headers={"Cache-Control": "public, max-age=86400"})


@router.post("/{history_id}/revert", response_model=ApplyResult)
async def revert(history_id: int) -> ApplyResult:
    entry = history.get_entry(history_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="History entry not found")
    server = db.get_server(entry["server_id"], include_token=True)
    if server is None:
        raise HTTPException(status_code=404, detail="Server not found")

    data, content_type = history.read_image(entry)
    try:
        await client_for(server).set_image(entry["item_id"], entry["target"], data, content_type)
    except MediaError as exc:
        return ApplyResult(ok=False, message=f"Revert failed: {exc}")

    # Reverting is itself a new apply — recorded fresh rather than mutating
    # the entry reverted to, so the history stays a true timeline.
    history.record(
        entry["server_id"],
        entry["item_id"],
        entry["target"],
        data,
        content_type,
        entry["provider"],
        entry["item_title"],
    )
    return ApplyResult(ok=True, message=f"Reverted {entry['target']}.")
